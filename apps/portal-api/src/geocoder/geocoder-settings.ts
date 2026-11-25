// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The portal's managed geocoder (Admin -> Geocoding).
 *
 * An admin picks regions; portal-worker downloads their OpenStreetMap
 * extracts, builds an open-geocode pack and serves it. Everything the
 * page shows and the worker needs lives in one system_setting row:
 * the choices, the build status and a short log. The OpenAddresses
 * token, when there is one, is the row's encrypted secret.
 */
import {
  decryptCredential,
  encryptCredential,
} from '../items/credential-cipher.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export const GEOCODER_SETTING_KEY = 'managed-geocoder';

/** Lines of build output kept for the admin page. */
export const GEOCODER_LOG_LINES = 60;

export type GeocoderRefresh = 'off' | 'monthly' | 'quarterly';

export type GeocoderStatus =
  | 'none'
  | 'queued'
  | 'downloading'
  | 'building'
  | 'ready'
  | 'failed';

export interface GeocoderRegion {
  /** Geofabrik id, for example `us/west-virginia`. */
  id: string;
  name: string;
  /** The .osm.pbf download. Only download.geofabrik.de is accepted. */
  pbfUrl: string;
}

export interface GeocoderSettings {
  regions: GeocoderRegion[];
  /** U.S. Census address ranges (TIGER). */
  tiger: boolean;
  /** OpenAddresses points. Needs the token. */
  openAddresses: boolean;
  /** OpenAddresses username the token was created for, when connected from the page. */
  oaAccount: string | null;
  refresh: GeocoderRefresh;
  status: GeocoderStatus;
  /** Short human line about the current step. */
  statusMessage: string | null;
  /** When the current or last build started (ISO). */
  startedAt: string | null;
  /** When the served pack was built (ISO). */
  builtAt: string | null;
  /** Regions the served pack was built from. */
  builtRegions: string[];
  packBytes: number | null;
  log: string[];
}

export const EMPTY_GEOCODER_SETTINGS: GeocoderSettings = {
  regions: [],
  tiger: true,
  openAddresses: false,
  oaAccount: null,
  refresh: 'off',
  status: 'none',
  statusMessage: null,
  startedAt: null,
  builtAt: null,
  builtRegions: [],
  packBytes: null,
  log: [],
};

const GEOFABRIK_HOST = 'download.geofabrik.de';

/** True for an https .osm.pbf link on download.geofabrik.de. */
export function isGeofabrikPbfUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === GEOFABRIK_HOST &&
    url.pathname.endsWith('.osm.pbf') &&
    !url.search &&
    !url.username &&
    !url.password
  );
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read a stored row value, dropping anything malformed. */
export function parseGeocoderSettings(value: unknown): GeocoderSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const regions: GeocoderRegion[] = Array.isArray(v.regions)
    ? (v.regions as unknown[]).flatMap((r) => {
        const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        const id = str(o.id);
        const name = str(o.name);
        const pbfUrl = str(o.pbfUrl);
        if (!id || !name || !pbfUrl || !isGeofabrikPbfUrl(pbfUrl)) return [];
        return [{ id, name, pbfUrl }];
      })
    : [];
  const status = [
    'none',
    'queued',
    'downloading',
    'building',
    'ready',
    'failed',
  ].includes(v.status as string)
    ? (v.status as GeocoderStatus)
    : 'none';
  const refresh = ['off', 'monthly', 'quarterly'].includes(v.refresh as string)
    ? (v.refresh as GeocoderRefresh)
    : 'off';
  return {
    regions,
    tiger: typeof v.tiger === 'boolean' ? v.tiger : true,
    openAddresses: v.openAddresses === true,
    oaAccount: str(v.oaAccount),
    refresh,
    status,
    statusMessage: str(v.statusMessage),
    startedAt: str(v.startedAt),
    builtAt: str(v.builtAt),
    builtRegions: Array.isArray(v.builtRegions)
      ? (v.builtRegions as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    packBytes:
      typeof v.packBytes === 'number' && Number.isFinite(v.packBytes) ? v.packBytes : null,
    log: Array.isArray(v.log)
      ? (v.log as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .slice(-GEOCODER_LOG_LINES)
      : [],
  };
}

export interface StoredGeocoder {
  settings: GeocoderSettings;
  /** Decrypted OpenAddresses token, or null. Never sent to a browser. */
  oaToken: string | null;
}

export async function readGeocoderSetting(
  prisma: PrismaService,
): Promise<StoredGeocoder> {
  const row = await prisma.systemSetting.findFirst({
    where: { key: GEOCODER_SETTING_KEY },
  });
  if (!row) return { settings: { ...EMPTY_GEOCODER_SETTINGS }, oaToken: null };
  let oaToken: string | null = null;
  if (row.encryptedSecret && row.encryptedSecretIv) {
    try {
      oaToken = decryptCredential(
        row.encryptedSecret,
        row.encryptedSecretIv,
        GEOCODER_SETTING_KEY,
      );
    } catch {
      oaToken = null;
    }
  }
  return { settings: parseGeocoderSettings(row.value), oaToken };
}

/**
 * Merge `patch` into the stored settings. `oaToken`: undefined keeps
 * the stored token, null clears it, a string replaces it.
 */
export async function writeGeocoderSetting(
  prisma: PrismaService,
  patch: Partial<GeocoderSettings>,
  opts: { oaToken?: string | null | undefined; userId?: string | null | undefined } = {},
): Promise<GeocoderSettings> {
  const current = await prisma.systemSetting.findFirst({
    where: { key: GEOCODER_SETTING_KEY },
  });
  const next = parseGeocoderSettings({
    ...parseGeocoderSettings(current?.value),
    ...patch,
  });
  let encryptedSecret = current?.encryptedSecret ?? null;
  let encryptedSecretIv = current?.encryptedSecretIv ?? null;
  if (opts.oaToken === null) {
    encryptedSecret = null;
    encryptedSecretIv = null;
  } else if (typeof opts.oaToken === 'string') {
    const enc = encryptCredential(opts.oaToken, GEOCODER_SETTING_KEY);
    encryptedSecret = enc.ciphertext;
    encryptedSecretIv = enc.iv;
  }
  const data = {
    value: next as unknown as object,
    encryptedSecret,
    encryptedSecretIv,
    updatedBy: opts.userId ?? null,
  };
  await prisma.systemSetting.upsert({
    where: { key: GEOCODER_SETTING_KEY },
    create: { key: GEOCODER_SETTING_KEY, ...data },
    update: data,
  });
  return next;
}

/** Days between scheduled rebuilds, or null when refresh is off. */
export function refreshDays(refresh: GeocoderRefresh): number | null {
  if (refresh === 'monthly') return 30;
  if (refresh === 'quarterly') return 91;
  return null;
}

/** True when a ready pack is due for its scheduled rebuild. */
export function refreshDue(settings: GeocoderSettings, now = Date.now()): boolean {
  const days = refreshDays(settings.refresh);
  if (days === null || settings.status !== 'ready' || !settings.builtAt) return false;
  const built = Date.parse(settings.builtAt);
  return Number.isFinite(built) && now - built >= days * 24 * 60 * 60 * 1000;
}
