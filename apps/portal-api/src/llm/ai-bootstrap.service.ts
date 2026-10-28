// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService } from './ai-config.service.js';
import { isAiProviderId, type AiProviderId } from './providers.js';

/**
 * Apply PORTAL_AI_BOOTSTRAP_* into org_ai_provider on boot.
 *
 * The public demo's golden restore wipes the app DB every night, so
 * a key saved only in the UI would vanish. Keeping the key in
 * .env.prod (never in the dump) and re-applying here survives the
 * reset without putting a secret in the golden snapshot.
 *
 * Both API replicas may race this upsert; that is fine. The key is
 * never logged.
 */
@Injectable()
export class AiBootstrapService implements OnModuleInit {
  private readonly log = new Logger(AiBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AiConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const apiKey = (process.env.PORTAL_AI_BOOTSTRAP_API_KEY ?? '').trim();
    if (!apiKey) return;

    const providerRaw = (process.env.PORTAL_AI_BOOTSTRAP_PROVIDER ?? 'openai')
      .trim()
      .toLowerCase();
    if (!isAiProviderId(providerRaw)) {
      this.log.warn(
        `PORTAL_AI_BOOTSTRAP_PROVIDER="${providerRaw}" is not a known provider; skipping AI bootstrap.`,
      );
      return;
    }
    const provider: AiProviderId = providerRaw;
    const model = (process.env.PORTAL_AI_BOOTSTRAP_MODEL ?? '').trim() ||
      defaultModel(provider);
    const baseUrl = (process.env.PORTAL_AI_BOOTSTRAP_BASE_URL ?? '').trim();
    const orgSlug =
      (process.env.PORTAL_AI_BOOTSTRAP_ORG_SLUG ?? '').trim() ||
      (process.env.DEFAULT_ORG_SLUG ?? '').trim() ||
      'gratis-gis';

    try {
      const org = await this.prisma.organization.findUnique({
        where: { slug: orgSlug },
        select: { id: true },
      });
      if (!org) {
        this.log.warn(
          `AI bootstrap: organization slug "${orgSlug}" not found; skipping.`,
        );
        return;
      }

      const admin = await this.prisma.user.findFirst({
        where: { orgId: org.id, orgRole: 'admin', deletedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!admin) {
        this.log.warn(
          `AI bootstrap: no admin user in org "${orgSlug}"; skipping.`,
        );
        return;
      }

      const input: {
        provider: AiProviderId;
        model: string;
        apiKey: string;
        baseUrl?: string;
      } = { provider, model, apiKey };
      if (provider === 'openai-compatible' && baseUrl) {
        input.baseUrl = baseUrl;
      }

      const saved = await this.config.save(org.id, admin.id, input);
      this.log.log(
        `AI bootstrap applied for org "${orgSlug}" ` +
          `(provider=${saved.provider}, model=${saved.model}, configured=${saved.configured}).`,
      );
    } catch (err) {
      this.log.warn(
        `AI bootstrap failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}

function defaultModel(provider: AiProviderId): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-haiku-4-5';
    case 'xai':
      return 'grok-3-mini';
    case 'openai-compatible':
      return 'llama3.2';
  }
}
