// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProviderClient, ProviderCallError } from './ai-provider.client.js';
import { aiNotConfigured } from './ai-draft.service.js';
import {
  attributeLine,
  inlineFeatures,
  parseFeatureAnswer,
  questionTokens,
  renderFeaturePrompt,
  UnusableFeatureAnswer,
} from './feature-ask.js';

export interface FeatureHit {
  id: string;
  attributes: Record<string, string>;
}

export interface FeatureAskResult {
  answer: string;
  layerId: string;
  sampled: number;
  features: FeatureHit[];
}

const QUESTION_MAX = 500;
const SAMPLE_CAP = 30;

interface LayerShape {
  id: string;
  label?: string;
  editingPolicy?: 'all-rows' | 'own-rows-only';
  geometryType?: string | null;
}

/**
 * Answers a question from rows the caller can already read.
 * The sample is attribute text only. The model cannot name a
 * row that was not in that sample.
 */
@Injectable()
export class AiFeaturesService {
  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly features: DataLayerFeaturesService,
    private readonly config: AiConfigService,
    private readonly client: AiProviderClient,
  ) {}

  async ask(
    user: AuthUser,
    itemId: string,
    rawQuestion: string,
    layerId: string | undefined,
  ): Promise<FeatureAskResult> {
    const question = rawQuestion.trim();
    if (!question || question.length > QUESTION_MAX) {
      throw new BadRequestException(
        `Ask in 1 to ${QUESTION_MAX} characters.`,
      );
    }

    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer' || item.orgId !== user.orgId) {
      throw new NotFoundException('Item not found');
    }
    const inline = inlineFeatures(item.data);
    if (inline.length > 0 || readVersion(item.data) === 1) {
      const tokens = questionTokens(question);
      const matched = inline.filter((row) => {
        if (tokens.length === 0) return true;
        const hay = attributeLine(row.id, row.properties).line.toLowerCase();
        return tokens.some((token) => hay.includes(token));
      });
      const chosen = (matched.length > 0 ? matched : inline).slice(0, SAMPLE_CAP);
      const byId = new Map(
        chosen.map((row) => [row.id, attributeLine(row.id, row.properties)]),
      );
      return this.answer(user, 'features', byId, question);
    }
    const layers = readLayers(item.data);
    if (layers.length === 0) {
      throw new BadRequestException(
        'This data layer has no layers to ask.',
      );
    }
    const layer = layerId
      ? layers.find((entry) => entry.id === layerId)
      : layers[0];
    if (!layer) {
      throw new BadRequestException('That layer is not on this item.');
    }

    const shares = ((item as { shares?: ItemShare[] }).shares ?? []) as ItemShare[];
    const rowScope = this.sharing.effectiveRowScope(
      user,
      item as unknown as Item,
      shares,
      layer.editingPolicy ?? 'all-rows',
      'read',
    );
    const geoLimit = await this.sharing.geoLimitFor(
      user,
      item as unknown as Item,
      shares,
    );
    const shared = {
      ...(rowScope === 'own' ? { ownRowsOnly: { userId: user.id } } : {}),
      ...(geoLimit ? { geoLimit } : {}),
    };

    const byId = new Map<string, { line: string; attributes: Record<string, string> }>();
    const tokens = questionTokens(question);
    for (const token of tokens) {
      try {
        const found = await this.features.searchFeatures(item.id, layer.id, {
          q: token,
          limit: 8,
          ...shared,
        });
        for (const hit of found.results) {
          if (byId.has(hit.id) || byId.size >= SAMPLE_CAP) continue;
          byId.set(hit.id, attributeLine(hit.id, hit.properties));
        }
      } catch {
        break;
      }
    }

    if (byId.size < SAMPLE_CAP) {
      const listed = await this.features.listFeatures(item.id, layer.id, {
        limit: SAMPLE_CAP,
        ...shared,
        ...(layer.geometryType === null ? { isTable: true as const } : {}),
      });
      for (const feature of listed.features) {
        if (byId.has(feature.id) || byId.size >= SAMPLE_CAP) continue;
        byId.set(feature.id, attributeLine(feature.id, feature.properties));
      }
    }

    return this.answer(user, layer.id, byId, question);
  }

  private async answer(
    user: AuthUser,
    layerId: string,
    byId: Map<string, { line: string; attributes: Record<string, string> }>,
    question: string,
  ): Promise<FeatureAskResult> {
    if (byId.size === 0) {
      return {
        answer: 'This layer has no rows you can read.',
        layerId,
        sampled: 0,
        features: [],
      };
    }

    const stored = await this.config.loadUsable(user.orgId);
    if (!stored) throw aiNotConfigured();

    let text: string;
    try {
      text = await this.client.complete(
        stored,
        renderFeaturePrompt(
          [...byId.values()].map((row) => row.line),
          question,
        ),
      );
    } catch (err) {
      if (err instanceof ProviderCallError) {
        throw new BadGatewayException({
          statusCode: 502,
          code: 'ai_provider_error',
          error: 'Bad Gateway',
          message: err.message,
        });
      }
      throw err;
    }

    let parsed: { answer: string; ids: string[] };
    try {
      parsed = parseFeatureAnswer(text, new Set(byId.keys()));
    } catch (err) {
      if (err instanceof UnusableFeatureAnswer) {
        throw new BadGatewayException({
          statusCode: 502,
          code: 'ai_answer_unusable',
          error: 'Bad Gateway',
          message: 'The model did not return a usable answer. Try rephrasing the question.',
        });
      }
      throw err;
    }

    return {
      answer: parsed.answer,
      layerId,
      sampled: byId.size,
      features: parsed.ids.map((id) => ({
        id,
        attributes: byId.get(id)?.attributes ?? {},
      })),
    };
  }
}

function readVersion(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === 'number' ? version : null;
}

function readLayers(data: unknown): LayerShape[] {
  if (!data || typeof data !== 'object') return [];
  const version = (data as { version?: unknown }).version;
  if (version !== 3) return [];
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return [];
  const out: LayerShape[] = [];
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    const id = (layer as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    const label = (layer as { label?: unknown }).label;
    const editingPolicy = (layer as { editingPolicy?: unknown }).editingPolicy;
    const geometryType = (layer as { geometryType?: unknown }).geometryType;
    out.push({
      id,
      ...(typeof label === 'string' ? { label } : {}),
      ...(editingPolicy === 'all-rows' || editingPolicy === 'own-rows-only'
        ? { editingPolicy }
        : {}),
      ...(geometryType === null || typeof geometryType === 'string'
        ? { geometryType }
        : {}),
    });
  }
  return out;
}
