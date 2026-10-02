// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import type { ChatPrompt } from './item-context.js';
import {
  assertCompatibleBaseUrl,
  buildChatRequest,
  readProviderText,
  type StoredAiSecret,
} from './providers.js';

const MAX_RESPONSE_BYTES = 200_000;

export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly reason: 'unreachable' | 'http' | 'bad-json' | 'empty' | 'too-large',
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}

/**
 * One non-streaming chat call. `fetchImpl` is the global fetch in
 * production and a fake in tests. Redirects are refused so a
 * provider cannot bounce the key-bearing request at another host.
 */
@Injectable()
export class AiProviderClient {
  private readonly log = new Logger(AiProviderClient.name);
  fetchImpl: typeof fetch = fetch;

  async complete(config: StoredAiSecret, prompt: ChatPrompt): Promise<string> {
    if (config.provider === 'openai-compatible') {
      if (!config.baseUrl) {
        throw new ProviderCallError(
          'The AI provider is missing a base URL.',
          'unreachable',
        );
      }
      await assertCompatibleBaseUrl(config.baseUrl);
    }
    const req = buildChatRequest(config, prompt);
    let res: Response;
    try {
      res = await this.fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      this.log.warn(
        `ai provider ${config.provider} unreachable (${err instanceof Error ? err.name : 'error'})`,
      );
      throw new ProviderCallError(
        'The AI provider could not be reached.',
        'unreachable',
      );
    }
    if (!res.ok) {
      this.log.warn(`ai provider ${config.provider} returned HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderCallError(
        'The AI provider returned an error.',
        'http',
      );
    }
    const text = await readLimitedText(res, MAX_RESPONSE_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderCallError(
        'The AI provider response was not JSON.',
        'bad-json',
      );
    }
    try {
      return readProviderText(config.provider, payload);
    } catch {
      throw new ProviderCallError(
        'The AI provider response had no draft text.',
        'empty',
      );
    }
  }
}

async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new ProviderCallError(
        'The AI provider response was too large.',
        'too-large',
      );
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderCallError(
        'The AI provider response was too large.',
        'too-large',
      );
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
