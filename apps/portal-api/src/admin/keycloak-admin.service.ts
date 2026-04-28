import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';

import { SystemSettingsService } from '../notifications/system-settings.service.js';

/**
 * Thin wrapper around Keycloak's Admin REST API.
 *
 * Keycloak exposes admin endpoints under
 *   {KEYCLOAK_URL}/admin/realms/{realm}/...
 *
 * We authenticate with a confidential service-account client that has
 * the `manage-users` role from the realm-management built-in client.
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
export class KeycloakAdminService implements OnModuleInit {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private tokenCache: TokenCache | null = null;

  constructor(private readonly settings: SystemSettingsService) {}

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
   */
  async onModuleInit(): Promise<void> {
    if (!this.isConfigured()) return;
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

  /** Base URL of the Keycloak server (no trailing slash). */
  private get keycloakUrl(): string {
    return (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(
      /\/$/,
      '',
    );
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

  async getUser(id: string): Promise<KeycloakUserRep> {
    const token = await this.getAccessToken();
    const res = await fetch(this.adminUrl(`/users/${id}`), {
      headers: { authorization: `Bearer ${token}` },
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
      const text = await res.text();
      if (res.status === 409) {
        throw new BadGatewayException(
          `A user with that username or email already exists (${text}).`,
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
      } catch (err) {
        setupEmailError =
          err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `User ${input.username} created in Keycloak but setup email failed: ${setupEmailError}`,
        );
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

