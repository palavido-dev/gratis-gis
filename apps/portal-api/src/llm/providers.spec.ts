// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  buildChatRequest,
  chatCompletionsUrl,
  normalizeCompatibleBaseUrl,
  readProviderText,
  type StoredAiSecret,
} from './providers.js';

const PROMPT = { system: 'sys', user: 'hello' };

function config(overrides: Partial<StoredAiSecret> = {}): StoredAiSecret {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: null,
    apiKey: 'sk-test-secret',
    ...overrides,
  };
}

describe('buildChatRequest', () => {
  it('calls OpenAI on the official host and keeps the key out of the body', () => {
    const req = buildChatRequest(
      config({ baseUrl: 'http://169.254.169.254/latest' }),
      PROMPT,
    );
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test-secret');
    expect(req.body).not.toContain('sk-test-secret');
    expect(req.body).not.toContain('169.254.169.254');
    const parsed = JSON.parse(req.body) as {
      model: string;
      response_format: { type: string };
    };
    expect(parsed.model).toBe('gpt-4o-mini');
    expect(parsed.response_format).toEqual({ type: 'json_object' });
  });

  it('calls xAI on the official host with a bearer token', () => {
    const req = buildChatRequest(
      config({ provider: 'xai', model: 'grok-3' }),
      PROMPT,
    );
    expect(req.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test-secret');
    expect(req.headers['x-api-key']).toBeUndefined();
  });

  it('calls Anthropic with x-api-key and no bearer header', () => {
    const req = buildChatRequest(
      config({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
      PROMPT,
    );
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-test-secret');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.body).not.toContain('sk-test-secret');
    const parsed = JSON.parse(req.body) as {
      system: string;
      messages: Array<{ role: string }>;
    };
    expect(parsed.system).toBe('sys');
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('appends /chat/completions to an Ollama base URL and skips response_format', () => {
    const req = buildChatRequest(
      config({
        provider: 'openai-compatible',
        model: 'llama3.2',
        baseUrl: 'http://127.0.0.1:11434/v1/',
      }),
      PROMPT,
    );
    expect(req.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test-secret');
    const parsed = JSON.parse(req.body) as { response_format?: unknown };
    expect(parsed.response_format).toBeUndefined();
  });

  it('does not double-append when the base URL already ends at chat/completions', () => {
    expect(
      chatCompletionsUrl('http://127.0.0.1:11434/v1/chat/completions'),
    ).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('refuses a metadata base URL for the compatible provider', () => {
    expect(() =>
      buildChatRequest(
        config({
          provider: 'openai-compatible',
          baseUrl: 'http://169.254.169.254/latest',
        }),
        PROMPT,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeCompatibleBaseUrl('http://[::ffff:169.254.169.254]/'),
    ).toThrow(BadRequestException);
  });

  it('allows a loopback Ollama URL', () => {
    expect(normalizeCompatibleBaseUrl('http://127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });
});

describe('readProviderText', () => {
  it('reads an OpenAI choices message', () => {
    expect(
      readProviderText('openai', {
        choices: [{ message: { content: '{"summary":"ok"}' } }],
      }),
    ).toBe('{"summary":"ok"}');
  });

  it('reads Anthropic text blocks', () => {
    expect(
      readProviderText('anthropic', {
        content: [{ type: 'text', text: '{"summary":"ok"}' }],
      }),
    ).toBe('{"summary":"ok"}');
  });
});
