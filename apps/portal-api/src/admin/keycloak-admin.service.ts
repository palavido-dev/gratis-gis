// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadGatewayException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';

import { LeaderElectionService } from '../cron/leader-election.service.js';
import { SystemSettingsService } from '../notifications/system-settings.service.js';
import {
  qgisRedirectUris,
  qgisRedirectsChanged,
} from './qgis-redirects.js';

/**
 * Thin wrapper around Keycloak's Admin REST API.
 *
 * Keycloak exposes admin endpoints under
 *   {KEYCLOAK_URL}/admin/realms/{realm}/...
 *
 * We authenticate with a confidential service-account client that has
 * `manage-users`, `manage-realm`, `view-identity-providers`, and
 * `manage-identity-providers` from the realm-management client.
 * The client credentials live in env vars:
 *
 *   KEYCLOAK_ADMIN_CLIENT_ID     (e.g. "portal-api-admin")
 *   KEYCLOAK_ADMIN_CLIENT_SECRET
 *
 * Tokens returned by Keycloak are cached in-process until ~60s before
 * their advertised expiry. This means `manage-users` doesn't become a
 * per-request roundtrip, and lets the controller stay dumb about auth.
 *
 * All outbound calls use the built-in global `fetch` (Node 18+).
 */
interface TokenCache {
  accessToken: string;
  /** Absolute epoch ms at which this token should be considered stale. */
  expiresAt: number;
}

export interface KeycloakUserRep {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  emailVerified?: boolean;
  requiredActions?: string[];
  createdTimestamp?: number;
  attributes?: Record<string, string[]>;
  /** Convenience: combined name for display. */
  fullName?: string;
  /**
   * Populated by createUser() / resetPassword() flows when the user
   * was created/updated successfully but the setup or password-reset
   * email could not be sent (typically realm SMTP not configured).
   * The caller decides whether to surface this; the user row is real
   * and usable either way, so we don't fail the whole operation.
   */
  setupEmailError?: string;
}

export interface KeycloakUserCreateInput {
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  /** When true, sends a Keycloak email with UPDATE_PASSWORD action. */
  sendSetupEmail?: boolean;
  /** Optional initial org role attribute; stored as user attribute
   *  `org_role` since Keycloak doesn't have a first-class role field
   *  mapping here without custom mappers. */
  orgRole?: 'viewer' | 'contributor' | 'admin';
  /** Optional org slug; stored on the user attribute `org`. */
  org?: string;
  enabled?: boolean;
}

export interface KeycloakUserUpdateInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled?: boolean;
  orgRole?: 'viewer' | 'contributor' | 'admin';
}

@Injectable()
export class KeycloakAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private tokenCache: TokenCache | null = null;

  constructor(
    private readonly settings: SystemSettingsService,
    private readonly leader: LeaderElectionService,
  ) {}

  /**
   * On boot, push our SMTP_* env vars into the Keycloak realm so that
   * Keycloak's built-in flows (invite emails, forgot-password, email
   * verification) deliver through the same relay our notifications
   * platform uses. Without this, a fresh dev/prod install hits
   * "Failed to send execute actions email" / 500 the first time an
   * admin clicks Invite, because the realm has no smtpServer config.
   *
   * Failures here are logged and swallowed: the admin Keycloak client
   * may not be configured yet (first run), Keycloak might still be
   * coming up, or the service-account might lack manage-realm. None
   * of those should crash portal-api's bootstrap.
   *
   * Idempotent: PUT /admin/realms/{realm} replaces the smtpServer
   * map, so repeated startups converge on the same config.
   *
   * Multi-replica safety: when N>1 portal-api replicas boot at the
   * same time, two concurrent PUTs against the same realm race
   * inside Keycloak's REALM_SMTP_CONFIG upsert (DELETE-then-INSERT
   * across separate JDBC transactions), and the loser surfaces as a
   * 409 "Realm with same name exists" plus a unique-constraint
   * violation in the Keycloak postgres logs. The end-state config is
   * still correct (whichever replica wins writes the right values),
   * but the noise hides real errors. Gating boot-time sync behind
   * the cron leader lock serializes the work to one replica per
   * boot wave. The admin-triggered path (saveSmtp on PUT
   * /admin/notifications/smtp) intentionally remains ungated since
   * it's already a single-request operation.
   *
   * Why onApplicationBootstrap and not onModuleInit: the leader
   * lock is acquired asynchronously inside LeaderElectionService's
   * own onModuleInit, and Nest does not strictly serialize
   * onModuleInit hooks across modules even when the import graph
   * looks like it should. Running our gating check from
   * onApplicationBootstrap (which fires only after every module's
   * onModuleInit chain has resolved) ensures leader.shouldRun() has
   * its final value.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.isConfigured()) return;
    // Only one replica per boot wave performs the realm-side
    // bootstrap. Non-leaders rely on the leader's converged state
    // and, in the rare leader-handoff case, the next leader's own
    // boot wave will re-sync. See class doc above.
    if (!this.leader.holdsLock()) {
      this.logger.log(
        'Skipping Keycloak realm bootstrap on this replica: another process holds the cron-leader lock. ' +
          'The admin can still trigger a sync at any time via PUT /admin/notifications/smtp.',
      );
      return;
    }
    // Self-heal: if the admin service-account client doesn't have
    // manage-realm yet, grant it now so the SMTP sync below can
    // succeed. Idempotent and safe to call repeatedly. Failure here
    // is logged but doesn't block bootstrap -- a misconfigured admin
    // client can't grant itself a role it doesn't already have, and
    // we'd rather the portal start than refuse to come up. (#139)
    try {
      await this.ensureManageRealm();
    } catch (err) {
      this.logger.warn(
        `Could not auto-grant manage-realm to admin service-account: ` +
          `${String(err)}. The admin Keycloak client needs realm-admin ` +
          `(or just manage-realm directly) for SMTP sync to work.`,
      );
    }
    // Tighten the QGIS client's loopback redirect on realms that were
    // imported before that URI required a port separator. Idempotent.
    // Failure does not stop startup.
    try {
      await this.ensureQgisRedirects();
    } catch (err) {
      this.logger.warn(
        `Could not update the qgis-plugin redirect URIs: ${String(err)}.`,
      );
    }
    // Skip the sync when SMTP isn't configured yet (no DB row, no
    // env). The admin can configure SMTP via /admin/notifications
    // and saveSmtp() will trigger the sync at that point.
    const cfg = await this.settings.getSmtpConfig();
    if (!cfg || !cfg.host) return;
    try {
      await this.syncRealmSmtp();
    } catch (err) {
      this.logger.warn(
        `Could not sync SMTP config to Keycloak realm: ${String(err)}. ` +
          `Invite emails will fail until the realm has smtpServer ` +
          `configured (Keycloak admin console -> realm settings -> Email).`,
      );
    }
  }

  /**
   * Base URL of the Keycloak server for server-to-server admin REST
   * calls and the client-credentials token mint.
   *
   * Prefers `KEYCLOAK_INTERNAL_URL` (eg `http://keycloak:8080` inside
   * the docker compose network) so admin REST traffic bypasses the
   * Caddy edge.  In prod the public hostname (KEYCLOAK_URL) has
   * `/admin/*` blocked at Caddy to keep the realm admin surface off
   * the public internet; portal-api's own admin calls would otherwise
   * 404 against that block, even though they run inside the docker
   * network.  Falls back to KEYCLOAK_URL when no internal URL is set
   * (single-host dev, or any deploy where the public URL is also
   * internally reachable).
   *
   * Issuer + JWKS lookups in jwt.strategy.ts still use KEYCLOAK_URL
   * because the JWT `iss` claim is the public hostname; that path is
   * not gated by the Caddy admin block.
   */
  private get keycloakUrl(): string {
    const url =
      process.env.KEYCLOAK_INTERNAL_URL ??
      process.env.KEYCLOAK_URL ??
      'http://localhost:8080';
    return url.replace(/\/$/, '');
  }

  /** Realm we operate against. */
  private get realm(): string {
    return process.env.KEYCLOAK_REALM ?? 'gratis-gis';
  }

  private get adminClientId(): string | undefined {
    return process.env.KEYCLOAK_ADMIN_CLIENT_ID;
  }
  private get adminClientSecret(): string | undefined {
    return process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
  }

  /**
   * Whether the admin integration is configured. Controllers can use
   * this to surface a clear 503 ("admin API not configured") rather
   * than a cryptic Keycloak error when an operator forgot the env vars.
   */
  isConfigured(): boolean {
    return Boolean(this.adminClientId && this.adminClientSecret);
  }

  /** Fetch and cache an admin access token via client_credentials grant. */
  private async getAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Keycloak admin API is not configured (missing KEYCLOAK_ADMIN_CLIENT_ID / _SECRET)',
      );
    }

    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.accessToken;
    }

    const tokenUrl = `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.adminClientId!,
      client_secret: this.adminClientSecret!,
    });

    let res: Response;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      this.logger.error(`Keycloak token endpoint unreachable: ${String(err)}`);
      throw new BadGatewayException(
        'Could not reach Keycloak to obtain an admin token',
      );
    }

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(
        `Keycloak token fetch failed: ${res.status} ${res.statusText} :: ${text}`,
      );
      throw new BadGatewayException(
        `Keycloak token fetch failed (${res.status}). Check client id / secret and service-account role mappings.`,
      );
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    // Refresh 60s before expiry to avoid race-at-the-edge failures.
    const expiresAt = Date.now() + (json.expires_in - 60) * 1000;
    this.tokenCache = { accessToken: json.access_token, expiresAt };
    return json.access_token;
  }

  /** Build an admin endpoint URL inside the target realm. */
  private adminUrl(path: string): string {
    return `${this.keycloakUrl}/admin/realms/${this.realm}${path}`;
  }

  /** GET /users or /users?search=... */
  async listUsers(opts: {
    search?: string;
    first?: number;
    max?: number;
  } = {}): Promise<KeycloakUserRep[]> {
    const token = await this.getAccessToken();
    const qs = new URLSearchParams();
    if (opts.search) qs.set('search', opts.search);
    qs.set('first', String(opts.first ?? 0));
    qs.set('max', String(opts.max ?? 100));
    qs.set('briefRepresentation', 'false');
    const res = await fetch(this.adminUrl(`/users?${qs.toString()}`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak listUsers failed: ${res.status} ${res.statusText}`,
      );
    }
    const rows = (await res.json()) as KeycloakUserRep[];
    // Attach a display-friendly fullName so UI code doesn't have to
    // concat first+last everywhere.
    return rows.map((r) => ({
      ...r,
      fullName: combineName(r.firstName, r.lastName, r.username),
    }));
  }

  /**
   * Usernames (lowercased) of every client's service-account user.
   * Keycloak leaves these users out of GET /users and /users/count, so
   * a caller that treats "absent from the user list" as "deleted" has
   * to exclude them using this set. One client listing plus one
   * lookup per client that has service accounts enabled.
   */
  async listServiceAccountUsernames(): Promise<Set<string>> {
    const token = await this.getAccessToken();
    const headers = { authorization: `Bearer ${token}` };
    const res = await fetch(this.adminUrl('/clients?first=0&max=1000'), {
      headers,
    });
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak client list failed: ${res.status} ${res.statusText}`,
      );
    }
    const clients = (await res.json()) as Array<{
      id: string;
      serviceAccountsEnabled?: boolean;
    }>;
    const names = new Set<string>();
    for (const c of clients) {
      if (!c.serviceAccountsEnabled) continue;
      const saRes = await fetch(
        this.adminUrl(`/clients/${c.id}/service-account-user`),
        { headers },
      );
      if (!saRes.ok) {
        throw new BadGatewayException(
          `Keycloak service-account lookup failed: ${saRes.status} ${saRes.statusText}`,
        );
      }
      const sa = (await saRes.json()) as { username?: string };
      if (sa.username) names.add(sa.username.toLowerCase());
    }
    return names;
  }

  /**
   * Resolve a Keycloak user id from a username via
   * GET /users?username=<exact>&exact=true. Returns null when nothing
   * matches. Seeded / pre-Keycloak local rows carry a different local
   * user.id than their Keycloak sub (auth-sync upserts by username and
   * never rewrites the id), so any admin action that starts from a
   * local id must resolve through the username first, or the write
   * hits a nonexistent Keycloak id and 404s.
   */
  async findUserIdByUsername(username: string): Promise<string | null> {
    const token = await this.getAccessToken();
    const qs = new URLSearchParams({
      username,
      exact: 'true',
      max: '1',
      briefRepresentation: 'true',
    });
    const res = await fetch(this.adminUrl(`/users?${qs.toString()}`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak findUserIdByUsername failed: ${res.status} ${res.statusText}`,
      );
    }
    const rows = (await res.json()) as Array<{ id?: string }>;
    return rows[0]?.id ?? null;
  }

  async getUser(
    id: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<KeycloakUserRep> {
    const token = await this.getAccessToken();
    const res = await fetch(this.adminUrl(`/users/${id}`), {
      headers: { authorization: `Bearer ${token}` },
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    if (res.status === 404) {
      throw new NotFoundException(`Keycloak user ${id} not found`);
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak getUser failed: ${res.status} ${res.statusText}`,
      );
    }
    const row = (await res.json()) as KeycloakUserRep;
    return {
      ...row,
      fullName: combineName(row.firstName, row.lastName, row.username),
    };
  }

  /**
   * POST /users then GET /users?username=... to fetch the newly-created
   * id. Optionally triggers Keycloak's setup email (UPDATE_PASSWORD +
   * VERIFY_EMAIL actions) so the invitee can establish their password
   * out-of-band.
   */
  async createUser(
    input: KeycloakUserCreateInput,
  ): Promise<KeycloakUserRep> {
    const token = await this.getAccessToken();
    const attributes: Record<string, string[]> = {};
    if (input.orgRole) attributes.org_role = [input.orgRole];
    if (input.org) attributes.org = [input.org];
    const body = {
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: input.enabled ?? true,
      attributes,
    };
    const res = await fetch(this.adminUrl('/users'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await res.text();
      // Keycloak answers 409 when the username or email is taken. That
      // is a client conflict, not an upstream failure, so the web UI can
      // tell it apart from a Keycloak outage (502).
      if (res.status === 409) {
        throw new ConflictException(
          'A user with that username or email already exists.',
        );
      }
      throw new BadGatewayException(
        `Keycloak createUser failed: ${res.status} ${res.statusText}`,
      );
    }
    // Keycloak returns 201 with a Location header pointing at the new user.
    const location = res.headers.get('location');
    if (!location) {
      throw new InternalServerErrorException(
        'Keycloak did not return a Location header for the created user.',
      );
    }
    const id = location.split('/').pop();
    if (!id) {
      throw new InternalServerErrorException(
        'Could not parse new user id from Location header.',
      );
    }

    let setupEmailError: string | undefined;
    if (input.sendSetupEmail) {
      // The user row in Keycloak is the source of truth -- if email
      // delivery fails (realm SMTP misconfigured, relay down, etc.) we
      // still want the row so an admin can retry the email later or
      // share the password-set URL out-of-band. Capture the error and
      // attach it to the rep instead of throwing.
      try {
        await this.sendExecuteActionsEmail(id, [
          'UPDATE_PASSWORD',
          'VERIFY_EMAIL',
        ]);
      } catch {
        setupEmailError = 'smtp_unavailable';
        this.logger.warn(`Setup email failed for user id ${id}`);
      }
    }
    const rep = await this.getUser(id);
    if (setupEmailError) rep.setupEmailError = setupEmailError;
    return rep;
  }

  async updateUser(
    id: string,
    patch: KeycloakUserUpdateInput,
  ): Promise<KeycloakUserRep> {
    const token = await this.getAccessToken();
    // PUT /users/{id} is a full replacement for the writeable fields.
    // We read-modify-write so partial updates don't clobber attributes.
    const current = await this.getUser(id);
    const attributes = { ...(current.attributes ?? {}) };
    if (patch.orgRole !== undefined) attributes.org_role = [patch.orgRole];

    const body: Record<string, unknown> = {
      firstName: patch.firstName ?? current.firstName,
      lastName: patch.lastName ?? current.lastName,
      email: patch.email ?? current.email,
      enabled: patch.enabled ?? current.enabled,
      attributes,
    };
    // A new address is unproven. Keycloak's admin API keeps the old
    // emailVerified flag on a PUT, so clear it and ask the user to
    // verify on the next sign-in. Without this, whoever changed the
    // address could use "Forgot password" on it straight away.
    if (
      patch.email !== undefined &&
      patch.email.trim().toLowerCase() !== (current.email ?? '').trim().toLowerCase()
    ) {
      body.emailVerified = false;
      body.requiredActions = Array.from(
        new Set([...(current.requiredActions ?? []), 'VERIFY_EMAIL']),
      );
    }
    const res = await fetch(this.adminUrl(`/users/${id}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      throw new NotFoundException(`Keycloak user ${id} not found`);
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak updateUser failed: ${res.status} ${res.statusText}`,
      );
    }
    return this.getUser(id);
  }

  async deleteUser(id: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(this.adminUrl(`/users/${id}`), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      throw new NotFoundException(`Keycloak user ${id} not found`);
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak deleteUser failed: ${res.status} ${res.statusText}`,
      );
    }
  }

  /** PUT /users/{id}/execute-actions-email with the list of actions. */
  async sendExecuteActionsEmail(
    id: string,
    actions: Array<'UPDATE_PASSWORD' | 'VERIFY_EMAIL' | 'UPDATE_PROFILE'>,
  ): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      this.adminUrl(`/users/${id}/execute-actions-email`),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(actions),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      // Keycloak returns 500 ("Failed to send execute actions email")
      // when the realm has no smtpServer configured. We sync that on
      // boot via onModuleInit, but a partial / failed sync (e.g.
      // service-account missing manage-realm) leaves us here. The
      // caller (admin-users.controller) maps this to a clear 502 so
      // the admin UI can surface the real fix.
      const isLikelySmtpMissing =
        res.status === 500 && /send.*email/i.test(text);
      const hint = isLikelySmtpMissing
        ? ' (likely cause: Keycloak realm has no smtpServer configured. ' +
          'Set SMTP_HOST/SMTP_PORT/SMTP_FROM in portal-api env so the ' +
          'realm sync on boot can populate it, and ensure the admin ' +
          'service-account client has the manage-realm role.)'
        : '';
      throw new BadGatewayException(
        `Keycloak execute-actions-email failed: ${res.status} ${res.statusText} :: ${text}${hint}`,
      );
    }
  }

  /**
   * PUT /admin/realms/{realm} with smtpServer drawn from SMTP_* env.
   * Called from onModuleInit so Keycloak's invite + forgot-password
   * flows share our SMTP relay and Matt only configures it once.
   *
   * Requires the admin service-account to have the realm-management
   * client role `manage-realm`. If it doesn't, Keycloak returns 403
   * and we log a warning telling the operator how to grant it.
   *
   * Returns the keys we set so callers / tests can introspect; today
   * only onModuleInit calls it.
   */
  async syncRealmSmtp(): Promise<Record<string, string>> {
    const cfg = await this.settings.getSmtpConfig();
    if (!cfg || !cfg.host) {
      throw new Error(
        'SMTP not configured. Save SMTP via /admin/notifications first.',
      );
    }
    // Keycloak's smtpServer is Map<String,String>: stringified booleans,
    // ports, etc. STARTTLS is the default for port 587 so we set
    // starttls=true and ssl=false there; ssl=true on 465.
    const smtpServer: Record<string, string> = {
      host: cfg.host,
      port: String(cfg.port),
      from: cfg.fromAddress,
      fromDisplayName: cfg.fromDisplayName,
      ssl: cfg.secure ? 'true' : 'false',
      starttls: cfg.secure ? 'false' : 'true',
      auth: cfg.user ? 'true' : 'false',
    };
    if (cfg.user) smtpServer.user = cfg.user;
    if (cfg.password) smtpServer.password = cfg.password;

    const token = await this.getAccessToken();
    // Keycloak's PUT on the realm endpoint accepts a partial body and
    // merges it into the existing RealmRepresentation, so we don't have
    // to GET-then-PUT. Sending only smtpServer keeps unrelated fields
    // (login flows, themes, etc) untouched.
    const res = await fetch(this.adminUrl(''), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ smtpServer }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) {
        throw new Error(
          `Keycloak refused realm SMTP sync (403). Grant the admin ` +
            `service-account client the realm-management role ` +
            `'manage-realm' so portal-api can update smtpServer.`,
        );
      }
      throw new Error(
        `Keycloak realm SMTP sync failed: ${res.status} ${res.statusText} :: ${text}`,
      );
    }
    this.logger.log(
      `Synced SMTP config to Keycloak realm '${this.realm}' (host=${cfg.host} port=${cfg.port} secure=${cfg.secure})`,
    );
    return smtpServer;
  }

  /**
   * Ensure the admin service-account client has the realm-management
   * roles the portal's own admin screens call. Idempotent.
   *
   * `manage-realm` covers realm SMTP and authenticator required
   * actions. Identity providers are a separate pair of roles:
   * `view-identity-providers` and `manage-identity-providers`.
   * Keycloak does not treat either as a composite of `manage-realm`,
   * so stopping once `manage-realm` is present leaves the Sign-in
   * page with a 403.
   *
   * The grant only succeeds when this service account can already
   * assign roles (realm-admin, or manage-users plus the roles
   * themselves). A client that only has `manage-users` cannot add
   * these; deploy and restore grant them with the master admin.
   * A failure here is logged at bootstrap and does not stop the
   * process.
   */
  async ensureManageRealm(): Promise<void> {
    if (!this.isConfigured()) return;
    const token = await this.getAccessToken();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };

    // 1. Find the admin client by clientId env var, get its
    //    service-account user id.
    const clientId = this.adminClientId!;
    const clientsRes = await fetch(
      this.adminUrl(`/clients?clientId=${encodeURIComponent(clientId)}`),
      { headers },
    );
    if (!clientsRes.ok) {
      throw new Error(
        `Lookup of admin client '${clientId}' failed: ${clientsRes.status}`,
      );
    }
    const clients = (await clientsRes.json()) as Array<{ id: string }>;
    if (clients.length === 0) {
      throw new Error(
        `Admin client '${clientId}' not found in realm '${this.realm}'.`,
      );
    }
    const clientUuid = clients[0]!.id;
    const saRes = await fetch(
      this.adminUrl(`/clients/${clientUuid}/service-account-user`),
      { headers },
    );
    if (!saRes.ok) {
      throw new Error(
        `Service-account-user lookup failed: ${saRes.status} (the admin ` +
          `client must have 'Service accounts enabled' in Keycloak).`,
      );
    }
    const saUser = (await saRes.json()) as { id: string };

    // 2. Find the realm-management client (built into Keycloak).
    const rmRes = await fetch(
      this.adminUrl(`/clients?clientId=realm-management`),
      { headers },
    );
    if (!rmRes.ok) {
      throw new Error(`realm-management lookup failed: ${rmRes.status}`);
    }
    const rmClients = (await rmRes.json()) as Array<{ id: string }>;
    if (rmClients.length === 0) {
      throw new Error('Built-in realm-management client missing.');
    }
    const rmClientUuid = rmClients[0]!.id;

    const required = [
      'manage-realm',
      'view-identity-providers',
      'manage-identity-providers',
    ];
    const existingRes = await fetch(
      this.adminUrl(
        `/users/${saUser.id}/role-mappings/clients/${rmClientUuid}`,
      ),
      { headers },
    );
    if (!existingRes.ok) {
      throw new Error(
        `Existing role-mappings lookup failed: ${existingRes.status}`,
      );
    }
    const existing = (await existingRes.json()) as Array<{ name: string }>;
    const missing = required.filter(
      (name) => !existing.some((role) => role.name === name),
    );
    if (missing.length === 0) return;

    const roles: Array<{ id: string; name: string }> = [];
    for (const name of missing) {
      const roleRes = await fetch(
        this.adminUrl(`/clients/${rmClientUuid}/roles/${name}`),
        { headers },
      );
      if (!roleRes.ok) {
        throw new Error(`${name} role lookup failed: ${roleRes.status}`);
      }
      roles.push((await roleRes.json()) as { id: string; name: string });
    }
    const grantRes = await fetch(
      this.adminUrl(
        `/users/${saUser.id}/role-mappings/clients/${rmClientUuid}`,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(roles),
      },
    );
    if (!grantRes.ok) {
      const text = await grantRes.text();
      throw new Error(
        `Could not grant ${missing.join(', ')}: ${grantRes.status} :: ${text}. ` +
          `Keycloak will not let this service account assign roles it does not ` +
          `already hold. Grant them from the Keycloak admin console, or let ` +
          `deploy.sh do it with the master admin.`,
      );
    }
    // The token used above was minted before the grant, so it does
    // not carry the new roles. Drop it so the next admin call mints
    // a fresh one.
    this.tokenCache = null;
    this.logger.log(
      `Granted ${missing.join(', ')} to admin service-account '${clientId}' on realm '${this.realm}'.`,
    );
  }

  /**
   * Replace an open loopback redirect on the qgis-plugin client.
   * Reads the client, edits redirectUris, and writes the same
   * representation back. Users, credentials, and other clients are
   * left as they are. A missing client is ignored so a realm that
   * does not ship the plugin still boots.
   */
  async ensureQgisRedirects(): Promise<void> {
    if (!this.isConfigured()) return;
    const token = await this.getAccessToken();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const listRes = await fetch(
      this.adminUrl(`/clients?clientId=qgis-plugin`),
      { headers },
    );
    if (!listRes.ok) {
      throw new Error(`qgis-plugin lookup failed: ${listRes.status}`);
    }
    const clients = (await listRes.json()) as Array<{ id: string }>;
    if (clients.length === 0) return;
    const id = clients[0]!.id;
    const getRes = await fetch(this.adminUrl(`/clients/${id}`), { headers });
    if (!getRes.ok) {
      throw new Error(`qgis-plugin read failed: ${getRes.status}`);
    }
    const client = (await getRes.json()) as {
      redirectUris?: string[];
    };
    if (!qgisRedirectsChanged(client.redirectUris)) return;
    client.redirectUris = qgisRedirectUris(client.redirectUris);
    const putRes = await fetch(this.adminUrl(`/clients/${id}`), {
      method: 'PUT',
      headers,
      body: JSON.stringify(client),
    });
    if (!putRes.ok) {
      const text = await putRes.text();
      throw new Error(`qgis-plugin update failed: ${putRes.status} :: ${text}`);
    }
    this.logger.log(
      `Updated qgis-plugin redirect URIs on realm '${this.realm}'.`,
    );
  }

  /**
   * Identity providers configured on the realm. Secrets are not
   * returned. `domain` is the optional email domain this portal
   * stored on the provider so the sign-in page can hint it.
   */
  async listIdentityProviders(): Promise<
    Array<{ alias: string; displayName: string; enabled: boolean; domain: string | null }>
  > {
    const token = await this.getAccessToken();
    const res = await fetch(this.adminUrl('/identity-provider/instances'), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      this.logger.error(
        `Listing identity providers failed: ${res.status}. The admin ` +
          `service account needs realm-management view-identity-providers ` +
          `and manage-identity-providers.`,
      );
      throw new BadGatewayException('Could not load sign-in settings.');
    }
    const rows = (await res.json()) as Array<{
      alias?: string;
      displayName?: string;
      enabled?: boolean;
      config?: Record<string, string>;
    }>;
    return rows
      .filter((row) => typeof row.alias === 'string' && row.alias.length > 0)
      .map((row) => ({
        alias: row.alias!,
        displayName: row.displayName || row.alias!,
        enabled: row.enabled !== false,
        domain: row.config?.gratisDomain?.trim() || null,
      }));
  }

  /**
   * Add one OpenID Connect sign-in method. New accounts receive the
   * caller's organization and the viewer role, so a first login can
   * enter the portal without an invite. The client secret is sent
   * to Keycloak and not stored in the portal database.
   */
  async createOidcProvider(input: {
    alias: string;
    displayName: string;
    clientId: string;
    clientSecret: string;
    authorizationUrl: string;
    tokenUrl: string;
    orgSlug: string;
    domain: string | null;
  }): Promise<void> {
    const token = await this.getAccessToken();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const config: Record<string, string> = {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      authorizationUrl: input.authorizationUrl,
      tokenUrl: input.tokenUrl,
      defaultScope: 'openid email profile',
      syncMode: 'IMPORT',
    };
    if (input.domain) config.gratisDomain = input.domain;
    const created = await fetch(this.adminUrl('/identity-provider/instances'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alias: input.alias,
        displayName: input.displayName,
        providerId: 'oidc',
        enabled: true,
        trustEmail: true,
        storeToken: false,
        firstBrokerLoginFlowAlias: 'first broker login',
        config,
      }),
    });
    if (!created.ok) {
      const text = await created.text();
      throw new BadGatewayException(
        `Could not add the sign-in method (${created.status}). ${text.slice(0, 180)}`,
      );
    }
    await this.addHardcodedMapper(input.alias, headers, 'org', input.orgSlug);
    await this.addHardcodedMapper(input.alias, headers, 'org_role', 'viewer');
  }

  async deleteIdentityProvider(alias: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      this.adminUrl(`/identity-provider/instances/${encodeURIComponent(alias)}`),
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok && res.status !== 404) {
      throw new BadGatewayException(
        `Could not remove the sign-in method (${res.status}).`,
      );
    }
  }

  /** Whether CONFIGURE_TOTP is a default required action on the realm. */
  async getMfaRequired(): Promise<boolean> {
    const token = await this.getAccessToken();
    const res = await fetch(this.adminUrl('/authentication/required-actions'), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      this.logger.error(
        `Reading required actions failed: ${res.status}. The admin ` +
          `service account needs realm-management manage-realm.`,
      );
      throw new BadGatewayException('Could not load sign-in settings.');
    }
    const rows = (await res.json()) as Array<{
      alias?: string;
      defaultAction?: boolean;
    }>;
    return rows.some(
      (row) => row.alias === 'CONFIGURE_TOTP' && row.defaultAction === true,
    );
  }

  async setMfaRequired(required: boolean): Promise<void> {
    const token = await this.getAccessToken();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const list = await fetch(this.adminUrl('/authentication/required-actions'), {
      headers,
    });
    if (!list.ok) {
      throw new BadGatewayException('Could not read MFA settings.');
    }
    const rows = (await list.json()) as Array<Record<string, unknown>>;
    const current = rows.find((row) => row.alias === 'CONFIGURE_TOTP');
    const body = {
      ...(current ?? { alias: 'CONFIGURE_TOTP', name: 'Configure OTP', providerId: 'CONFIGURE_TOTP' }),
      alias: 'CONFIGURE_TOTP',
      enabled: true,
      defaultAction: required,
    };
    const updated = await fetch(
      this.adminUrl('/authentication/required-actions/CONFIGURE_TOTP'),
      { method: 'PUT', headers, body: JSON.stringify(body) },
    );
    if (!updated.ok) {
      throw new BadGatewayException(
        `Could not update MFA (${updated.status}).`,
      );
    }
    // A default action is only given to accounts created after it is
    // set. Existing accounts get the action directly, so the switch
    // means what the screen says: everyone sets up an authenticator
    // on their next sign-in. Turning it off takes the pending action
    // back off accounts that have not done it yet.
    await this.applyMfaToExistingUsers(required, headers);
  }

  /**
   * Add CONFIGURE_TOTP to every existing account that has no OTP
   * credential (required) or remove a still pending one (not
   * required). Service accounts are left alone: they never sign in
   * through the browser. Returns how many accounts were changed.
   */
  private async applyMfaToExistingUsers(
    required: boolean,
    headers: Record<string, string>,
  ): Promise<number> {
    const PAGE = 100;
    let changed = 0;
    for (let first = 0; ; first += PAGE) {
      const users = await this.listUsers({ first, max: PAGE });
      for (const u of users) {
        if (u.username.startsWith('service-account-')) continue;
        const actions = u.requiredActions ?? [];
        const pending = actions.includes('CONFIGURE_TOTP');
        let next: string[] | null = null;
        if (required && !pending) {
          const creds = await fetch(this.adminUrl(`/users/${u.id}/credentials`), {
            headers,
          });
          if (!creds.ok) {
            throw new BadGatewayException(
              `MFA was turned on, but existing accounts could not be checked (${creds.status}).`,
            );
          }
          const rows = (await creds.json()) as Array<{ type?: string }>;
          if (!rows.some((c) => c.type === 'otp')) {
            next = [...actions, 'CONFIGURE_TOTP'];
          }
        } else if (!required && pending) {
          next = actions.filter((a) => a !== 'CONFIGURE_TOTP');
        }
        if (!next) continue;
        // Keycloak's PUT only changes the fields present in the body.
        const res = await fetch(this.adminUrl(`/users/${u.id}`), {
          method: 'PUT',
          headers,
          body: JSON.stringify({ requiredActions: next }),
        });
        if (!res.ok && res.status !== 404) {
          throw new BadGatewayException(
            `MFA was changed, but account ${u.username} could not be updated (${res.status}).`,
          );
        }
        changed += 1;
      }
      if (users.length < PAGE) break;
    }
    return changed;
  }

  private async addHardcodedMapper(
    alias: string,
    headers: Record<string, string>,
    attribute: string,
    value: string,
  ): Promise<void> {
    const res = await fetch(
      this.adminUrl(
        `/identity-provider/instances/${encodeURIComponent(alias)}/mappers`,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: attribute,
          identityProviderAlias: alias,
          identityProviderMapper: 'hardcoded-attribute-idp-mapper',
          config: {
            attribute,
            'attribute.value': value,
            syncMode: 'INHERIT',
          },
        }),
      },
    );
    if (!res.ok) {
      throw new BadGatewayException(
        `The sign-in method was added, but the ${attribute} claim could not be set (${res.status}).`,
      );
    }
  }
}

function combineName(
  firstName: string | undefined,
  lastName: string | undefined,
  username: string,
): string {
  const parts = [firstName, lastName].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  if (parts.length > 0) return parts.join(' ');
  return username;
}

