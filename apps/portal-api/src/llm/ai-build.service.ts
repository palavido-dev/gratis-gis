// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_VIEWER_TOOLS,
  type DataLayerDataV3,
  type FeatureField,
  type MapData,
  type MapLayer,
  type ViewerData,
  type WebAppData,
} from '@gratis-gis/shared-types';
import type { FormSchema, Question } from '@gratis-gis/form-schema';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { hasCapability } from '../auth/capabilities.js';
import { ItemsService } from '../items/items.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProviderClient, ProviderCallError } from './ai-provider.client.js';
import { aiNotConfigured } from './ai-draft.service.js';
import {
  parseBuildPlan,
  UnusablePlanError,
  type BuildForm,
  type BuildLayer,
  type BuildPlan,
  type BuildQuestion,
  type CatalogLayer,
} from './build-plan.js';

export interface BuiltItem {
  id: string;
  type: string;
  title: string;
}

export interface BuildResult {
  summary: string;
  plan: BuildPlan;
  created: BuiltItem[];
}

const INSTRUCTION_MAX = 4000;

@Injectable()
export class AiBuildService {
  constructor(
    private readonly items: ItemsService,
    private readonly config: AiConfigService,
    private readonly client: AiProviderClient,
  ) {}

  async build(user: AuthUser, rawInstruction: string): Promise<BuildResult> {
    const instruction = rawInstruction.trim();
    if (!instruction || instruction.length > INSTRUCTION_MAX) {
      throw new BadRequestException(
        `Describe what to build in 1 to ${INSTRUCTION_MAX} characters.`,
      );
    }
    if (!hasCapability(user, 'can_publish_items')) {
      throw new ForbiddenException(
        'Creating items requires the contributor or admin role.',
      );
    }

    const stored = await this.config.loadUsable(user.orgId);
    if (!stored) throw aiNotConfigured();

    const catalog = await this.catalog(user);
    const prompt = renderBuildPrompt(catalog, instruction);
    let text: string;
    try {
      text = await this.client.complete(stored, prompt);
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

    let plan: BuildPlan;
    try {
      plan = parseBuildPlan(text, catalog);
    } catch (err) {
      if (err instanceof UnusablePlanError) {
        throw new BadGatewayException({
          statusCode: 502,
          code: 'ai_plan_unusable',
          error: 'Bad Gateway',
          message: err.message,
        });
      }
      throw err;
    }

    const created = await this.apply(user, plan);
    return { summary: plan.summary, plan, created };
  }

  private async catalog(user: AuthUser): Promise<CatalogLayer[]> {
    const rows = (await this.items.list(user, {
      type: 'data_layer',
      limit: 30,
    })) as unknown as Array<{ id: string; title: string; data: unknown }>;
    const out: CatalogLayer[] = [];
    for (const row of rows) {
      const layer = readCatalogLayer(row);
      if (layer) out.push(layer);
    }
    return out;
  }

  private async apply(user: AuthUser, plan: BuildPlan): Promise<BuiltItem[]> {
    const created: BuiltItem[] = [];
    const resolved = new Map<string, { itemId: string; layerKey: string; title: string }>();

    for (const layer of plan.layers) {
      if (layer.reuse) {
        resolved.set(layer.ref, {
          itemId: layer.reuse.itemId,
          layerKey: layer.reuse.layerKey,
          title: layer.title,
        });
        continue;
      }
      const item = await this.items.create(user, {
        type: 'data_layer',
        title: layer.title,
        description: plan.summary,
        data: layerData(layer) as unknown as Prisma.InputJsonValue,
      });
      const layerKey = layer.ref;
      resolved.set(layer.ref, { itemId: item.id, layerKey, title: layer.title });
      created.push({ id: item.id, type: 'data_layer', title: layer.title });
    }

    let mapId: string | null = null;
    if (plan.map) {
      const layers: MapLayer[] = [];
      for (const entry of plan.map.layers) {
        const target = resolved.get(entry.ref);
        if (!target) continue;
        layers.push(mapLayer(target, entry.color));
      }
      if (layers.length > 0) {
        const data: MapData = {
          version: 1,
          basemap: '',
          center: plan.map.center,
          zoom: plan.map.zoom,
          bearing: 0,
          pitch: 0,
          layers,
          search: { enabled: true, geocoding: true },
        };
        const item = await this.items.create(user, {
          type: 'map',
          title: plan.map.title,
          description: plan.summary,
          data: data as unknown as Prisma.InputJsonValue,
        });
        mapId = item.id;
        created.push({ id: item.id, type: 'map', title: plan.map.title });
      }
    }

    if (plan.form) {
      const linked = plan.form.layerRef
        ? resolved.get(plan.form.layerRef) ?? null
        : null;
      const data = formData(plan.form, linked);
      const item = await this.items.create(user, {
        type: 'form',
        title: plan.form.title,
        description: plan.summary,
        data: data as unknown as Prisma.InputJsonValue,
      });
      await this.items.update(user, item.id, {
        data: { ...data, id: item.id } as unknown as Prisma.InputJsonValue,
      });
      created.push({ id: item.id, type: 'form', title: plan.form.title });
    }

    if (plan.app && mapId) {
      const targets = [...resolved.values()].map((layer) => ({
        dataLayerId: layer.itemId,
        layerKey: layer.layerKey,
      }));
      const viewer: ViewerData = {
        version: 1,
        mapId,
        targets,
        tools: [...DEFAULT_VIEWER_TOOLS],
      };
      const data: WebAppData = {
        version: 1,
        template: 'viewer',
        config: { template: 'viewer', viewer },
      };
      const item = await this.items.create(user, {
        type: 'web_app',
        title: plan.app.title,
        description: plan.summary,
        data: data as unknown as Prisma.InputJsonValue,
      });
      created.push({ id: item.id, type: 'web_app', title: plan.app.title });
    }

    return created;
  }
}

function readCatalogLayer(row: {
  id: string;
  title: string;
  data?: unknown;
}): CatalogLayer | null {
  const data = row.data as { layers?: unknown } | null;
  const layers = data && Array.isArray(data.layers) ? data.layers : [];
  const first = layers.find(
    (layer): layer is Record<string, unknown> =>
      !!layer && typeof layer === 'object' && !Array.isArray(layer),
  );
  if (!first) return null;
  const geometry = first.geometryType;
  if (geometry !== 'point' && geometry !== 'line' && geometry !== 'polygon') {
    return null;
  }
  const layerKey = typeof first.id === 'string' && first.id ? first.id : 'layer';
  const fields = Array.isArray(first.fields)
    ? first.fields
        .map((field) =>
          field && typeof field === 'object' && typeof (field as { name?: unknown }).name === 'string'
            ? (field as { name: string }).name
            : '',
        )
        .filter(Boolean)
        .slice(0, 12)
    : [];
  return { id: row.id, title: row.title, layerKey, geometry, fields };
}

function layerData(layer: BuildLayer): DataLayerDataV3 {
  const fields: FeatureField[] = layer.fields.map((field) => ({
    name: field.name,
    type: field.type,
    label: field.label,
    nullable: true,
    searchable: field.name === 'name',
  }));
  return {
    version: 3,
    storageType: 'postgis',
    layers: [
      {
        id: layer.ref,
        label: layer.title,
        name: layer.ref,
        geometryType: layer.geometry,
        fields,
        editingEnabled: true,
        attachmentsEnabled: false,
      },
    ],
  };
}

function mapLayer(
  target: { itemId: string; layerKey: string; title: string },
  color: string,
): MapLayer {
  return {
    id: target.layerKey,
    title: target.title,
    visible: true,
    opacity: 1,
    source: {
      kind: 'data-layer',
      itemId: target.itemId,
      layerKey: target.layerKey,
    },
    style: {
      point: { ...DEFAULT_LAYER_STYLE.point, color },
      line: { ...DEFAULT_LAYER_STYLE.line, color },
      polygon: {
        ...DEFAULT_LAYER_STYLE.polygon,
        fillColor: color,
        strokeColor: color,
      },
    },
    renderer: { kind: 'simple' },
    popup: { ...DEFAULT_LAYER_POPUP },
    interactions: { ...DEFAULT_LAYER_INTERACTIONS },
    labels: { ...DEFAULT_LAYER_LABELS },
    search: { ...DEFAULT_LAYER_SEARCH },
    filter: null,
    scale: { ...DEFAULT_LAYER_SCALE },
    access: { ...DEFAULT_LAYER_ACCESS, entries: [] },
  };
}

function formData(
  form: BuildForm,
  linked: { itemId: string; layerKey: string } | null,
): FormSchema {
  const questions: Question[] = form.questions.map((question) =>
    toQuestion(question),
  );
  const geometry = form.questions.find((question) => question.type === 'geopoint');
  return {
    schemaVersion: 1,
    id: '',
    title: form.title,
    questions,
    ...(geometry ? { geometryQuestionId: geometry.id } : {}),
    ...(linked
      ? { linkedLayerId: linked.itemId, linkedLayerKey: linked.layerKey }
      : {}),
  };
}

function toQuestion(question: BuildQuestion): Question {
  const base = {
    id: question.id,
    label: question.label,
    required: question.required,
  };
  if (question.type === 'select-one') {
    return { ...base, type: 'select-one', choices: question.choices };
  }
  if (question.type === 'geopoint') {
    return { ...base, type: 'geopoint', capture: 'auto' };
  }
  if (question.type === 'multiline') {
    return { ...base, type: 'multiline', rows: 3 };
  }
  return { ...base, type: question.type };
}

function renderBuildPrompt(catalog: CatalogLayer[], instruction: string): {
  system: string;
  user: string;
} {
  const lines = catalog.map(
    (layer) =>
      `- ${layer.id} | ${layer.title} | ${layer.geometry} | key=${layer.layerKey} | fields=${layer.fields.join(',') || '(none)'}`,
  );
  return {
    system: [
      'You plan GratisGIS items from a description. Reply with one JSON object and no other text.',
      'Shape: {"summary":"","layers":[{"ref":"slug","title":"","geometry":"point|line|polygon","fields":[{"name":"snake","label":"","type":"string|number|boolean|date"}],"reuseItemId":null}],"map":{"title":"","center":[lng,lat],"zoom":12,"layers":[{"ref":"slug","color":"#21466e"}]},"form":{"title":"","layerRef":"slug","questions":[{"id":"slug","type":"text|multiline|number|integer|date|email|geopoint|select-one","label":"","required":true,"choices":[{"value":"a","label":"A"}]}]},"app":{"title":""}}',
      'Reuse an existing layer by setting reuseItemId to an id from the catalog. Leave it null to create a new empty layer. Never invent an id.',
      'Include a map when the description is about a map or an app. Include a form when the description collects information. Include an app when the description asks for an app or a viewer. Omit a section by setting it to null.',
      'At most 4 layers, 12 fields, and 12 questions. Field and question ids are lowercase snake_case.',
    ].join('\n'),
    user: `Existing layers:\n${lines.join('\n') || '(none)'}\n\nRequest:\n${instruction}`,
  };
}
