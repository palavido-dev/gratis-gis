// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { AdminGuard } from '../admin/admin.guard.js';
import { isAdminTierLocked } from '../admin/admin-tier-lock.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { runAsSystem } from '../common/tenant-context.js';
import {
  managedGeocoderBase,
  openGeocodeAnswers,
  openGeocodeBase,
} from '../ingest/open-geocode.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  coversUnitedStates,
  extractBytes,
  geofabrikOutlines,
  geofabrikRegions,
} from './geocoder-regions.js';
import {
  connectOpenAddresses,
  createOpenAddressesAccount,
  OpenAddressesError,
  signupProblem,
} from './openaddresses-account.js';
import { geocoderPaths } from './geocoder-runner.js';
import {
  readGeocoderSetting,
  writeGeocoderSetting,
  type GeocoderRefresh,
  type GeocoderSettings,
} from './geocoder-settings.js';

/** Most regions in one pack. Several states is fine; a continent is not a click away. */
const MAX_REGIONS = 12;

export interface GeocoderAdminView {
  /** The open-geocode binary is in this image. */
  available: boolean;
  /** PORTAL_LOCK_ADMIN_TIER: the page is read-only. */
  locked: boolean;
  /** OPEN_GEOCODE_URL is set, so the portal ignores the managed geocoder. */
  overriddenByEnv: boolean;
  /** The managed geocoder answers right now. */
  serving: boolean;
  oaTokenSaved: boolean;
  settings: GeocoderSettings;
}

interface SaveBody {
  regions?: Array<{ id?: unknown }>;
  tiger?: unknown;
  openAddresses?: unknown;
  refresh?: unknown;
  /** undefined keeps the stored token, null or '' clears it. */
  oaToken?: unknown;
}

/**
 * Admin -> Geocoding. Operator admins pick regions; portal-worker
 * builds and serves them (geocoder.worker.ts).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard, OperatorOrgGuard)
@Controller('admin/geocoder')
export class GeocoderAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  async get(): Promise<GeocoderAdminView> {
    return this.view();
  }

  @Get('regions')
  async regions() {
    try {
      return { regions: await geofabrikRegions() };
    } catch (err) {
      throw new ServiceUnavailableException(
        `Could not read the Geofabrik region list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Region outlines one level down, for the map picker. No parent: the continents. */
  @Get('regions/outlines')
  async outlines(@Query('parent') parent?: string) {
    const p = parent && /^[A-Za-z0-9/_-]{1,100}$/.test(parent) ? parent : null;
    try {
      return await geofabrikOutlines(p);
    } catch (err) {
      throw new ServiceUnavailableException(
        `Could not read the Geofabrik region outlines: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Download size of the picked regions, for the estimate before a build. */
  @Get('regions/size')
  async regionSize(@Query('ids') ids?: string) {
    const wanted = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_REGIONS);
    const all = await geofabrikRegions().catch(() => []);
    const sizes = await Promise.all(
      wanted.map(async (id) => {
        const r = all.find((x) => x.id === id);
        return { id, bytes: r ? await extractBytes(r.pbfUrl) : null };
      }),
    );
    return { sizes, us: coversUnitedStates(wanted.map((id) => ({ id })), all) };
  }

  @Put()
  async save(@CurrentUser() user: AuthUser, @Body() body: SaveBody): Promise<GeocoderAdminView> {
    this.refuseWhenLocked();
    const ids = Array.isArray(body?.regions)
      ? body.regions.map((r) => (typeof r?.id === 'string' ? r.id : '')).filter(Boolean)
      : [];
    if (ids.length > MAX_REGIONS) {
      throw new BadRequestException(`Pick at most ${MAX_REGIONS} regions.`);
    }
    const all = ids.length > 0 ? await geofabrikRegions() : [];
    const regions = ids.map((id) => {
      const r = all.find((x) => x.id === id);
      if (!r) throw new BadRequestException(`Unknown region: ${id}`);
      return { id: r.id, name: r.name, pbfUrl: r.pbfUrl };
    });
    const refresh: GeocoderRefresh = ['off', 'monthly', 'quarterly'].includes(body?.refresh as string)
      ? (body.refresh as GeocoderRefresh)
      : 'off';
    let oaToken: string | null | undefined;
    if (body?.oaToken === null || body?.oaToken === '') oaToken = null;
    else if (typeof body?.oaToken === 'string') {
      const t = body.oaToken.trim();
      if (!/^[A-Za-z0-9._-]{8,200}$/.test(t)) {
        throw new BadRequestException('That does not look like an OpenAddresses token.');
      }
      oaToken = t;
    }
    await runAsSystem('geocoder-save', () =>
      writeGeocoderSetting(
        this.prisma,
        {
          regions,
          tiger: body?.tiger !== false,
          openAddresses: body?.openAddresses === true,
          refresh,
          ...(oaToken !== undefined ? { oaAccount: null } : {}),
        },
        { oaToken, userId: user.id },
      ),
    );
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.geocoder',
      targetType: 'geocoder',
      targetId: 'settings',
      outcome: 'succeeded',
      detail: { regions: ids.join(','), refresh, openAddresses: body?.openAddresses === true },
    });
    return this.view();
  }

  @Post('build')
  async build(@CurrentUser() user: AuthUser): Promise<GeocoderAdminView> {
    this.refuseWhenLocked();
    const { settings } = await runAsSystem('geocoder-read', () => readGeocoderSetting(this.prisma));
    if (settings.regions.length === 0) {
      throw new BadRequestException('Pick at least one region first.');
    }
    if (['queued', 'downloading', 'building'].includes(settings.status)) {
      throw new ConflictException('A build is already running.');
    }
    await runAsSystem('geocoder-build', () =>
      writeGeocoderSetting(this.prisma, {
        status: 'queued',
        statusMessage: 'Waiting for the worker',
        log: [],
      }),
    );
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.geocoder',
      targetType: 'geocoder',
      targetId: 'build',
      outcome: 'succeeded',
      detail: { regions: settings.regions.map((r) => r.id).join(',') },
    });
    return this.view();
  }

  /**
   * Create an OpenAddresses account for the admin. OpenAddresses emails
   * a confirmation link; after it is clicked the admin connects below.
   * Nothing is stored here: the password goes to OpenAddresses only.
   */
  @Post('openaddresses/signup')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async openAddressesSignup(
    @CurrentUser() user: AuthUser,
    @Body() body: { username?: unknown; email?: unknown; password?: unknown },
  ) {
    this.refuseWhenLocked();
    const input = {
      username: typeof body?.username === 'string' ? body.username.trim() : '',
      email: typeof body?.email === 'string' ? body.email.trim() : '',
      password: typeof body?.password === 'string' ? body.password : '',
    };
    const problem = signupProblem(input);
    if (problem) throw new BadRequestException(problem);
    try {
      await createOpenAddressesAccount(input);
    } catch (err) {
      throw this.oaFailure(err);
    }
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.geocoder',
      targetType: 'openaddresses',
      targetId: 'signup',
      outcome: 'succeeded',
    });
    return { username: input.username };
  }

  /**
   * Sign in to OpenAddresses, create an API token and save it. Turns
   * OpenAddresses on. The password is not stored.
   */
  @Post('openaddresses/connect')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async openAddressesConnect(
    @CurrentUser() user: AuthUser,
    @Body() body: { username?: unknown; password?: unknown },
  ): Promise<GeocoderAdminView> {
    this.refuseWhenLocked();
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || username.length > 200 || !password || password.length > 200) {
      throw new BadRequestException('Enter your OpenAddresses username or email and password.');
    }
    let connected: { token: string; username: string };
    try {
      connected = await connectOpenAddresses({ username, password }, 'GratisGIS geocoder');
    } catch (err) {
      throw this.oaFailure(err);
    }
    await runAsSystem('geocoder-oa', () =>
      writeGeocoderSetting(
        this.prisma,
        { openAddresses: true, oaAccount: connected.username },
        { oaToken: connected.token, userId: user.id },
      ),
    );
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.geocoder',
      targetType: 'openaddresses',
      targetId: 'connect',
      outcome: 'succeeded',
    });
    return this.view();
  }

  private oaFailure(err: unknown): Error {
    if (err instanceof OpenAddressesError) {
      return err.status >= 500
        ? new ServiceUnavailableException(err.message)
        : new BadRequestException(err.message);
    }
    return new ServiceUnavailableException('Could not reach OpenAddresses.');
  }

  /** Try the managed geocoder from the admin page. */
  @Get('test')
  async test(@Query('q') q?: string) {
    const text = (q ?? '').trim().slice(0, 200);
    if (text.length < 3) return { results: [] };
    const base = managedGeocoderBase();
    if (!base) throw new ServiceUnavailableException('MANAGED_GEOCODER_URL is not set.');
    let body: unknown;
    try {
      const res = await fetch(`${base}/geocode?${new URLSearchParams({ q: text, limit: '5' })}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      throw new ServiceUnavailableException(
        `The geocoder did not answer: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const features = (body as { features?: unknown[] })?.features ?? [];
    return {
      results: (features as Array<{
        geometry?: { coordinates?: number[] };
        properties?: { label?: string; layer?: string; accuracy?: string };
      }>).map((f) => ({
        label: f.properties?.label ?? '',
        layer: f.properties?.layer ?? null,
        accuracy: f.properties?.accuracy ?? null,
        lon: f.geometry?.coordinates?.[0] ?? null,
        lat: f.geometry?.coordinates?.[1] ?? null,
      })),
    };
  }

  private refuseWhenLocked(): void {
    if (isAdminTierLocked()) {
      throw new ForbiddenException(
        'Geocoder settings are locked on this portal. The operator sets them with GEOCODER_REGIONS.',
      );
    }
  }

  private async view(): Promise<GeocoderAdminView> {
    const stored = await runAsSystem('geocoder-read', () => readGeocoderSetting(this.prisma));
    const base = managedGeocoderBase();
    let available = false;
    try {
      await access(geocoderPaths().bin, fsConstants.X_OK);
      available = true;
    } catch {
      available = false;
    }
    return {
      available,
      locked: isAdminTierLocked(),
      overriddenByEnv: openGeocodeBase() !== null,
      serving: base ? await openGeocodeAnswers(fetch, base) : false,
      oaTokenSaved: stored.oaToken !== null,
      settings: stored.settings,
    };
  }
}
