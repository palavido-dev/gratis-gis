// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  assertSafeOutboundUrl,
  isPrivateOrLoopbackHost,
  UnsafeOutboundUrlError,
} from '../common/net-guards.js';

/**
 * Opt-in model vendors. Commercial ids always call a fixed official
 * host. `openai-compatible` is the only id that accepts an admin-
 * supplied base URL (Ollama, or a proxy in front of one).
 */
export const AI_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'xai',
  'openai-compatible',
] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export function isAiProviderId(value: string): value is AiProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

const OFFICIAL_CHAT_URL: Record<
  Exclude<AiProviderId, 'openai-compatible'>,
  string
> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

export interface ChatPrompt {
  system: string;
  user: string;
}

export interface ProviderHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface StoredAiSecret {
  provider: AiProviderId;
  model: string;
  baseUrl: string | null;
  apiKey: string;
}

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_OUTPUT_TOKENS = 1200;

/**
 * Build the outbound HTTP request for one chat completion.
 * The API key is placed only in a header, never in the URL or body.
 * A base URL on a commercial provider is ignored so a saved row
 * cannot retarget api.openai.com at an internal host.
 */
export function buildChatRequest(
  config: StoredAiSecret,
  prompt: ChatPrompt,
): ProviderHttpRequest {
  if (config.provider === 'anthropic') {
    return {
      url: OFFICIAL_CHAT_URL.anthropic,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      }),
    };
  }

  const url =
    config.provider === 'openai-compatible'
      ? chatCompletionsUrl(requireCompatibleBaseUrl(config.baseUrl))
      : OFFICIAL_CHAT_URL[config.provider];

  // `response_format` is sent to the official OpenAI-shaped hosts.
  // Ollama's compatible endpoint has rejected the field on older
  // builds, so a local base URL relies on the system prompt plus
  // fence-stripping in the parser instead.
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  };
  if (config.provider !== 'openai-compatible') {
    body.response_format = { type: 'json_object' };
  }

  return {
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * Synchronous checks for an OpenAI-compatible base URL: http(s),
 * no embedded userinfo, no query or fragment, and not a link-local
 * or cloud-metadata address. Does not resolve DNS. Public hosts
 * are checked again by `assertCompatibleBaseUrl`.
 */
export function normalizeCompatibleBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BadRequestException('Base URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Base URL must be http or https.');
  }
  if (url.username || url.password) {
    throw new BadRequestException(
      'Base URL cannot include a username or password.',
    );
  }
  if (url.search || url.hash) {
    throw new BadRequestException(
      'Base URL cannot include a query string or fragment.',
    );
  }
  if (isMetadataHost(url.hostname)) {
    throw new BadRequestException(
      'Base URL must not point at a link-local or cloud-metadata address.',
    );
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Save-time and call-time check. Loopback, RFC1918, and single-label
 * docker names are allowed so a local Ollama works. Any other host
 * goes through the shared SSRF guard, including the DNS rebinding
 * check, so a public name cannot resolve at a metadata address.
 */
export async function assertCompatibleBaseUrl(raw: string): Promise<string> {
  const normalized = normalizeCompatibleBaseUrl(raw);
  const host = new URL(normalized).hostname;
  if (isPrivateOrLoopbackHost(host)) return normalized;
  try {
    await assertSafeOutboundUrl(normalized);
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
  return normalized;
}

function requireCompatibleBaseUrl(baseUrl: string | null): string {
  if (!baseUrl || !baseUrl.trim()) {
    throw new BadRequestException(
      'A base URL is required for an OpenAI-compatible provider.',
    );
  }
  return normalizeCompatibleBaseUrl(baseUrl);
}

/**
 * Pull the assistant text out of a vendor JSON body. OpenAI, xAI,
 * and OpenAI-compatible servers share the choices/message shape.
 * Anthropic returns a content array.
 */
export function readProviderText(
  provider: AiProviderId,
  payload: unknown,
): string {
  if (provider === 'anthropic') {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Anthropic response was not an object.');
    }
    const content = (payload as { content?: unknown }).content;
    const text = readContentParts(content);
    if (!text) throw new Error('Anthropic response had no text.');
    return text;
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Provider response was not an object.');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Provider response had no choices.');
  }
  const first = choices[0];
  if (!first || typeof first !== 'object') {
    throw new Error('Provider response choice was empty.');
  }
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') {
    throw new Error('Provider response had no message.');
  }
  const text = readContentParts((message as { content?: unknown }).content);
  if (!text) throw new Error('Provider response message was empty.');
  return text;
}

function readContentParts(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) return null;
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') out += text;
  }
  return out.trim().length > 0 ? out : null;
}

/**
 * True for cloud instance-metadata targets and IPv6 link-local.
 * 169.254.0.0/16 is the range that includes 169.254.169.254.
 * IPv4-mapped IPv6 forms are reduced to the embedded v4 address
 * first so `[::ffff:169.254.169.254]` does not slip through.
 */
export function isMetadataHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    bare === 'metadata.google.internal' ||
    bare.endsWith('.metadata.google.internal')
  ) {
    return true;
  }
  if (bare.startsWith('fe80:')) return true;
  const v4 = ipv4FromHost(bare);
  if (!v4) return false;
  const parts = v4.split('.');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 169 && b === 254;
}

function ipv4FromHost(bare: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return bare;
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (!hex) return null;
  const hi = parseInt(hex[1] ?? '0', 16);
  const lo = parseInt(hex[2] ?? '0', 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
