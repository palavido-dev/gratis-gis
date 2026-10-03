// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProviderClient, ProviderCallError } from './ai-provider.client.js';
import { parseModelDraft, UnusableDraftError, type AiDraft } from './draft-parse.js';
import { extractItemContext, renderItemPrompt } from './item-context.js';

export function aiNotConfigured(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'ai_not_configured',
    error: 'Conflict',
    message:
      'AI is not configured. An organization admin needs to connect a provider.',
  });
}

/**
 * Builds a draft from an item the caller can already read.
 * `ItemsService.get` is the only item call: it 404s when the
 * caller cannot read, and this service never writes the item.
 */
@Injectable()
export class AiDraftService {
  constructor(
    private readonly items: ItemsService,
    private readonly config: AiConfigService,
    private readonly client: AiProviderClient,
  ) {}

  async draft(
    user: AuthUser,
    itemId: string,
    rawInstruction: string,
  ): Promise<{ draft: AiDraft }> {
    const instruction = rawInstruction.trim();
    if (!instruction || instruction.length > 2000) {
      throw new BadRequestException(
        'Instruction must be between 1 and 2000 characters.',
      );
    }

    const item = await this.items.get(user, itemId);
    if (item.orgId !== user.orgId) {
      throw new NotFoundException('Item not found');
    }

    const config = await this.config.loadUsable(user.orgId);
    if (!config) throw aiNotConfigured();

    const prompt = renderItemPrompt(
      extractItemContext({
        type: item.type,
        title: item.title,
        description: item.description,
        data: item.data,
      }),
      instruction,
    );

    let text: string;
    try {
      text = await this.client.complete(config, prompt);
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

    try {
      return { draft: parseModelDraft(text) };
    } catch (err) {
      if (err instanceof UnusableDraftError) {
        throw new BadGatewayException({
          statusCode: 502,
          code: 'ai_draft_unusable',
          error: 'Bad Gateway',
          message:
            'The model did not return a usable draft. Try rephrasing the instruction.',
        });
      }
      throw err;
    }
  }

  async status(user: AuthUser): Promise<{ configured: boolean }> {
    const config = await this.config.loadUsable(user.orgId);
    return { configured: config !== null };
  }
}
