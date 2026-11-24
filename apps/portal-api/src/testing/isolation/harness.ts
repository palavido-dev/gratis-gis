// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Boots the real API (AppModule, every controller, guard, pipe and
// interceptor) on a random local port against a migrated test database,
// for the two-organization isolation suites.
//
// What is real: routing, the global JwtAuthGuard (including @Public
// handling, API keys and the passport JWT path), AuthSyncService (the
// claims to user mapping, the org checks in multi mode), every
// controller, service and database query.
//
// What is replaced, and why:
// - The passport `jwt` strategy verifies tokens with a key made for
//   this run instead of Keycloak's JWKS. Its `validate` is the real
//   JwtStrategy.validate, so the azp check and AuthSyncService run.
// - Object storage is an in-memory map (no S3 server here).
// - Lifecycle hooks (onModuleInit and friends) are switched off except
//   on the database client and the import staging folder, so no
//   worker loop, cron, Keycloak call or bucket check runs. Requests
//   that enqueue jobs still write their job rows; nothing claims them.
// - Outbound HTTP from the app is refused: only calls to the app's
//   own port go through `fetch`.

import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { NotFoundException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Pool } from 'pg';

import { AppModule } from '../../app.module.js';
import { KeycloakAdminService, type KeycloakUserRep } from '../../admin/keycloak-admin.service.js';
import { AuthSyncService } from '../../auth/auth-sync.service.js';
import { SystemSettingsService } from '../../notifications/system-settings.service.js';
import { LeaderElectionService } from '../../cron/leader-election.service.js';
import { JwtStrategy, type KeycloakClaims } from '../../auth/jwt.strategy.js';
import { parseJwtAllowedAzp } from '../../auth/jwt-allowed-azp.js';
import { configureBodyParsers, rejectRepeatedQueryKeys } from '../../common/body-limits.js';
import { requestIdMiddleware } from '../../common/public-error.js';
import { resetTenancyModeForTests, type TenancyMode } from '../../common/tenancy.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IngestStagingService } from '../../ingest/ingest-staging.service.js';
import { StorageService } from '../../storage/storage.service.js';
import { applyTestMigrations } from '../apply-test-migrations.js';

export const TEST_ISSUER = 'http://isolation.test/realms/gratis-gis';

/** Lifecycle hooks that stay on: the database client and the staging folder. */
const KEEP_HOOKS = new Set<unknown>([PrismaService, IngestStagingService]);
function keepsHooks(inst: object, metatype: unknown): boolean {
  return KEEP_HOOKS.has(metatype) || inst instanceof ThrottlerGuard;
}

/** Nest library modules whose hooks run as in production. */
const LIBRARY_MODULES = new Set([
  'InternalCoreModule',
  'ConfigModule',
  'ConfigHostModule',
  'ThrottlerModule',
  'PassportModule',
]);
const HOOKS = [
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
] as const;

export function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A fresh database with the repo's migrations applied. */
export async function createMigratedDatabase(baseUrl: string, name: string): Promise<string> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = databaseUrl(baseUrl, name);
  applyTestMigrations(url, join(__dirname, '../../../prisma/migrations'));
  return url;
}

export async function dropDatabase(baseUrl: string, name: string): Promise<void> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// Test tokens

type KeyPair = { privateKey: string; publicKey: string };
let keys: KeyPair | undefined;

function keyPair(): KeyPair {
  if (!keys) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keys = {
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  }
  return keys;
}

const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

/** An RS256 access token shaped like Keycloak's, signed with this run's key. */
export function signTestToken(claims: Omit<KeycloakClaims, 'azp'> & { azp?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'isolation' }));
  const body = b64url(
    JSON.stringify({ azp: 'portal-web', iss: TEST_ISSUER, iat: now, exp: now + 3600, ...claims }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${b64url(signer.sign(keyPair().privateKey))}`;
}

/**
 * The passport `jwt` strategy with a local key. `validate` is the real
 * JwtStrategy.validate (azp allowlist, then AuthSyncService).
 */
class TestJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly allowedAzp = parseJwtAllowedAzp();

  constructor(private readonly authSync: AuthSyncService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      algorithms: ['RS256'],
      issuer: TEST_ISSUER,
      secretOrKey: keyPair().publicKey,
    });
  }

  validate(payload: KeycloakClaims): ReturnType<JwtStrategy['validate']> {
    return JwtStrategy.prototype.validate.call(this as unknown as JwtStrategy, payload);
  }
}

// ---------------------------------------------------------------------------
// In-memory object storage

/**
 * StorageService with an in-memory object map in place of S3. Only the
 * methods that move bytes are replaced; key building, signing and
 * validation stay real.
 */
export function memoryStorage(real: StorageService): StorageService {
  const objects = new Map<string, Buffer>();
  const overrides: Record<string, unknown> = {
    objects,
    async onModuleInit() {},
    async uploadBuffer(key: string, body: Buffer) {
      objects.set(key, Buffer.from(body));
      return key;
    },
    async uploadLocalFile(key: string) {
      objects.set(key, Buffer.alloc(0));
      return key;
    },
    async streamObject(key: string) {
      const v = objects.get(key);
      if (!v) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return {
        body: Readable.from(v),
        contentType: 'application/octet-stream',
        contentLength: v.length,
      };
    },
    async objectExists(key: string) {
      return objects.has(key);
    },
    async headObjectSize(key: string) {
      return objects.get(key)?.length ?? null;
    },
    async deleteObject(key: string) {
      return objects.delete(key);
    },
    async listObjectsUnder(prefix: string) {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, v]) => ({ key, size: v.length, lastModified: new Date() }));
    },
    async listMultipartUploadsUnder() {
      return [];
    },
    async createMultipartUpload() {
      return `upload-${randomUUID()}`;
    },
    async abortMultipartUpload() {},
    async getBucketUsage() {
      return {
        objects: objects.size,
        bytes: [...objects.values()].reduce((n, b) => n + b.length, 0),
      };
    },
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------------------
// In-memory Keycloak realm

/**
 * One shared realm for every org, as on a real multi-org install: the
 * realm lists every user, and the API must keep each org to its own.
 * Realm-wide settings (identity providers, MFA, SMTP) are not modelled
 * and fail as a Keycloak outage would.
 */
export class MemoryRealm {
  readonly users = new Map<string, KeycloakUserRep>();

  add(u: { id: string; username: string; email: string; org: string; orgRole: string }): void {
    this.users.set(u.id, {
      id: u.id,
      username: u.username,
      email: u.email,
      enabled: true,
      fullName: u.username,
      attributes: { org: [u.org], org_role: [u.orgRole] },
    });
  }

  private find(id: string): KeycloakUserRep {
    const u = this.users.get(id);
    if (!u) throw new NotFoundException(`Keycloak user ${id} not found`);
    return u;
  }

  wrap(real: KeycloakAdminService): KeycloakAdminService {
    const users = this.users;
    const find = (id: string): KeycloakUserRep => this.find(id);
    const add = (u: Parameters<MemoryRealm['add']>[0]): void => this.add(u);
    const overrides: Record<string, unknown> = {
      isConfigured: () => true,
      async onApplicationBootstrap() {},
      async listUsers(opts: { search?: string; first?: number; max?: number } = {}) {
        const all = [...users.values()].filter(
          (u) =>
            !opts.search ||
            u.username.includes(opts.search) ||
            (u.email ?? '').includes(opts.search),
        );
        const first = opts.first ?? 0;
        return all.slice(first, first + (opts.max ?? 100)).map((u) => ({ ...u }));
      },
      async listServiceAccountUsernames() {
        return new Set<string>();
      },
      async findUserIdByUsername(username: string) {
        return [...users.values()].find((u) => u.username === username)?.id ?? null;
      },
      async isUsernameEnabled(username: string) {
        return [...users.values()].find((u) => u.username === username)?.enabled ?? false;
      },
      async getUser(id: string) {
        return { ...find(id) };
      },
      async createUser(input: { username: string; email: string; org?: string; orgRole?: string }) {
        const id = randomUUID();
        add({
          id,
          username: input.username,
          email: input.email,
          org: input.org ?? '',
          orgRole: input.orgRole ?? 'viewer',
        });
        return { ...find(id) };
      },
      async updateUser(id: string, patch: Partial<KeycloakUserRep>) {
        const u = find(id);
        Object.assign(u, patch);
        return { ...u };
      },
      async deleteUser(id: string) {
        find(id);
        users.delete(id);
      },
      async sendExecuteActionsEmail(id: string) {
        find(id);
      },
    };
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in overrides) return overrides[prop];
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Boot

export type HarnessOptions = {
  mode: TenancyMode;
  databaseUrl: string;
  /** GRATIS_OPERATOR_ORG_ID at boot; undefined leaves it unset. */
  operatorOrgId?: string | undefined;
};

export type IsolationApp = {
  app: INestApplication;
  baseUrl: string;
  realm: MemoryRealm;
  close(): Promise<void>;
};

const ENV_FOR_BOOT: Record<string, string> = {
  ENABLE_CRONS: 'false',
  NODE_ENV: 'test',
  KEYCLOAK_URL: 'http://isolation.test',
  KEYCLOAK_REALM: 'gratis-gis',
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'test',
  S3_BUCKET: 'gratisgis',
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PORTAL_BASE_URL: 'http://127.0.0.1',
  PORTAL_SCRIPTS_ENABLED: 'false',
  UPDATE_CHECK: 'off',
};

const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
}

const realFetch = globalThis.fetch;

/**
 * `fetch` for the test's own requests. The app's outbound calls go
 * through `globalThis.fetch` (see test-setup), which this harness
 * limits to the app's own address.
 */
export function testFetch(input: string, init?: RequestInit): Promise<Response> {
  return realFetch(input, init);
}

export async function bootIsolationApp(opts: HarnessOptions): Promise<IsolationApp> {
  const stagingDir = mkdtempSync(join(tmpdir(), 'gg-isolation-'));
  for (const [k, v] of Object.entries(ENV_FOR_BOOT)) setEnv(k, v);
  setEnv('DATABASE_URL', opts.databaseUrl);
  setEnv('DB_POOL_MAX', '6');
  setEnv('STAGING_DIR', stagingDir);
  setEnv('TILE_CACHE_DIR', join(stagingDir, 'tiles'));
  setEnv('BACKUP_DIR', join(stagingDir, 'backups'));
  setEnv('GRATIS_TENANCY', opts.mode === 'multi' ? 'multi' : undefined);
  setEnv('GRATIS_OPERATOR_ORG_ID', opts.operatorOrgId);
  resetTenancyModeForTests();

  const realm = new MemoryRealm();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JwtStrategy)
    .useFactory({
      factory: (a: AuthSyncService) => new TestJwtStrategy(a),
      inject: [AuthSyncService],
    })
    .overrideProvider(KeycloakAdminService)
    .useFactory({
      factory: (settings: SystemSettingsService, leader: LeaderElectionService) =>
        realm.wrap(new KeycloakAdminService(settings, leader)),
      inject: [SystemSettingsService, LeaderElectionService],
    })
    .overrideProvider(StorageService)
    .useFactory({
      factory: (cfg: ConfigService) => memoryStorage(new StorageService(cfg)),
      inject: [ConfigService],
    })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });

  // Lifecycle hooks off, except on the database client and staging.
  const container = app.get(ModulesContainer);
  for (const mod of container.values()) {
    // Framework modules (throttler, config, passport) need their hooks.
    if (LIBRARY_MODULES.has(mod.metatype?.name ?? '')) continue;
    for (const wrapper of mod.providers.values()) {
      const inst = wrapper.instance as Record<string, unknown> | null | undefined;
      if (!inst || typeof inst !== 'object' || keepsHooks(inst, wrapper.metatype)) continue;
      for (const hook of HOOKS) {
        if (typeof inst[hook] === 'function') inst[hook] = async () => undefined;
      }
    }
  }

  // The same request pipeline main.ts builds.
  app.use('/api/public', rejectRepeatedQueryKeys);
  configureBodyParsers(app);
  app.use(requestIdMiddleware);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.set('trust proxy', 1);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api', { exclude: ['/health', '/docs'] });

  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(baseUrl)) return realFetch(input, init);
    throw new Error(`outbound HTTP is off in the isolation harness: ${new URL(url).host}`);
  }) as typeof fetch;

  return {
    app,
    baseUrl,
    realm,
    async close() {
      globalThis.fetch = realFetch;
      await app.close();
      restoreEnv();
      resetTenancyModeForTests();
      rmSync(stagingDir, { recursive: true, force: true });
    },
  };
}
