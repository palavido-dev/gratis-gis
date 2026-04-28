import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  encryptCredential,
  decryptCredential,
} from '../items/credential-cipher.js';

/**
 * Platform-level settings the admin manages from the UI rather than
 * env files (#137). Today's only key is `smtp`. The shape is
 * key/value JSON for non-secret fields plus an encrypted blob for
 * secret material; the same AES-256-GCM cipher we use for ItemCredential
 * is reused, with the setting key as AAD so a password row can't
 * silently move between settings via SQL.
 *
 * The env vars (SMTP_HOST etc.) remain a *seed* layer: when the
 * system_setting row is absent we fall back to env, so a fresh
 * deployment with the env populated still works. Once an admin
 * saves config in the UI, the DB row wins forever (or until they
 * clear it).
 */
export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  fromAddress: string;
  fromDisplayName: string;
  user: string;
  /** Plaintext only when freshly written; otherwise empty + the
   *  hasPassword flag tells callers / UI we have one stored.
   *  Explicit `undefined` is allowed to keep object-literal callers
   *  happy under exactOptionalPropertyTypes without forcing every
   *  caller to delete the key when it's empty. */
  password?: string | undefined;
  hasPassword: boolean;
}

const SMTP_KEY = 'smtp';

@Injectable()
export class SystemSettingsService {
  private readonly log = new Logger(SystemSettingsService.name);
  /** Memoised SMTP config. Cleared by saveSmtpConfig() so a fresh
   *  read always reflects the most recent admin write. */
  private smtpCache: SmtpConfig | null | undefined = undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * Effective SMTP config: DB row if present, env fallback otherwise.
   * Returns null only when neither source has a host -- callers that
   * need to know whether SMTP is configured at all check
   * `cfg !== null && cfg.enabled && cfg.host`.
   */
  async getSmtpConfig(): Promise<SmtpConfig | null> {
    if (this.smtpCache !== undefined) return this.smtpCache;
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: SMTP_KEY },
    });
    if (row) {
      const parsed = parseSmtpRow(
        row.value as Record<string, unknown>,
        row.encryptedSecret,
        row.encryptedSecretIv,
      );
      this.smtpCache = parsed;
      return parsed;
    }
    // Fallback: synthesise from env vars so first-run deployments
    // that wrote SMTP_HOST etc. don't break before the admin clicks
    // Save.
    const fromEnv = this.smtpFromEnv();
    this.smtpCache = fromEnv;
    return fromEnv;
  }

  /**
   * Persist SMTP config to system_setting. Empty `password` means
   * "leave the existing encrypted password alone"; an explicit
   * empty-string write would set hasPassword=false. The UI
   * distinguishes by sending `password` only on rotate.
   */
  async saveSmtpConfig(
    input: Omit<SmtpConfig, 'hasPassword'>,
    actorId: string,
  ): Promise<SmtpConfig> {
    const existing = await this.prisma.systemSetting.findUnique({
      where: { key: SMTP_KEY },
    });
    const value: Record<string, unknown> = {
      enabled: input.enabled,
      host: input.host,
      port: input.port,
      secure: input.secure,
      fromAddress: input.fromAddress,
      fromDisplayName: input.fromDisplayName,
      user: input.user,
    };
    let encryptedSecret: string | null = existing?.encryptedSecret ?? null;
    let encryptedSecretIv: string | null = existing?.encryptedSecretIv ?? null;
    if (input.password !== undefined) {
      if (input.password.length === 0) {
        encryptedSecret = null;
        encryptedSecretIv = null;
      } else {
        const enc = encryptCredential(input.password, SMTP_KEY);
        encryptedSecret = enc.ciphertext;
        encryptedSecretIv = enc.iv;
      }
    }
    await this.prisma.systemSetting.upsert({
      where: { key: SMTP_KEY },
      create: {
        key: SMTP_KEY,
        value: value as object,
        encryptedSecret,
        encryptedSecretIv,
        updatedBy: actorId,
      },
      update: {
        value: value as object,
        encryptedSecret,
        encryptedSecretIv,
        updatedBy: actorId,
      },
    });
    this.smtpCache = undefined;
    const fresh = await this.getSmtpConfig();
    if (!fresh) {
      throw new Error('saveSmtpConfig wrote but readback returned null');
    }
    this.log.log(
      `SMTP config saved by ${actorId} (host=${fresh.host} port=${fresh.port} hasPassword=${fresh.hasPassword})`,
    );
    return fresh;
  }

  /** Drop the in-memory cache. Used by other services that want a
   *  fresh read after they know config changed elsewhere. */
  invalidateSmtpCache(): void {
    this.smtpCache = undefined;
  }

  private smtpFromEnv(): SmtpConfig | null {
    const host = this.cfg.get<string>('SMTP_HOST');
    if (!host) return null;
    const portRaw = this.cfg.get<string>('SMTP_PORT') ?? '587';
    const port = Number(portRaw);
    const secureRaw = (this.cfg.get<string>('SMTP_SECURE') ?? '').toLowerCase();
    const secure = secureRaw === 'true' || (secureRaw === '' && port === 465);
    const user = this.cfg.get<string>('SMTP_USER') ?? '';
    const pass = this.cfg.get<string>('SMTP_PASS') ?? '';
    const fromRaw =
      this.cfg.get<string>('SMTP_FROM') ?? 'GratisGIS <noreply@gratisgis.local>';
    const { from, fromDisplayName } = parseFrom(fromRaw);
    const enabled =
      (this.cfg.get<string>('NOTIFICATIONS_ENABLED') ?? '').toLowerCase() ===
      'true';
    return {
      enabled,
      host,
      port: Number.isFinite(port) ? port : 587,
      secure,
      fromAddress: from,
      fromDisplayName,
      user,
      password: pass || undefined,
      hasPassword: pass.length > 0,
    };
  }
}

function parseSmtpRow(
  value: Record<string, unknown>,
  encryptedSecret: string | null,
  encryptedSecretIv: string | null,
): SmtpConfig {
  const password =
    encryptedSecret && encryptedSecretIv
      ? safeDecrypt(encryptedSecret, encryptedSecretIv)
      : undefined;
  return {
    enabled: Boolean(value.enabled),
    host: typeof value.host === 'string' ? value.host : '',
    port: typeof value.port === 'number' ? value.port : 587,
    secure: Boolean(value.secure),
    fromAddress:
      typeof value.fromAddress === 'string' ? value.fromAddress : '',
    fromDisplayName:
      typeof value.fromDisplayName === 'string' ? value.fromDisplayName : '',
    user: typeof value.user === 'string' ? value.user : '',
    password,
    hasPassword: typeof password === 'string' && password.length > 0,
  };
}

function safeDecrypt(ct: string, iv: string): string | undefined {
  try {
    return decryptCredential(ct, iv, SMTP_KEY);
  } catch {
    // CREDENTIAL_ENCRYPTION_KEY may have rotated, AAD mismatch, etc.
    // Return undefined so the rest of the system behaves like
    // "password not configured"; admin re-saves to recover.
    return undefined;
  }
}

function parseFrom(raw: string): { from: string; fromDisplayName: string } {
  const m = raw.match(/^\s*(?:"?(.*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    return {
      from: (m[2] ?? '').trim(),
      fromDisplayName: (m[1] ?? '').trim(),
    };
  }
  return { from: raw.trim(), fromDisplayName: '' };
}
