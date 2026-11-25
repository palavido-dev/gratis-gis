// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from '@nestjs/common';

/**
 * The secret Esri client tokens (ArcGIS Pro, QGIS) are signed with.
 *
 * A token signed with it stands for a whole user, admins included, so
 * it must not be the MinIO secret, which storage and the point-cloud
 * worker (it parses uploaded files) also hold. On a server install
 * GRATIS_SIGNING_SECRET is passed to portal-api only. On a NAS it is in
 * the shared boot env file, but not in the reduced env files of chromium
 * and the point-cloud worker.
 *
 * deploy.sh and the NAS bootstrap add it to an existing install. Until
 * that has run once, the API falls back to the MinIO secret, which is
 * what every install used before, so an image-only update still starts.
 *
 * Only the Esri token uses this today. The print read credential and
 * upload handles still sign with the MinIO secret. They are narrower
 * credentials and can move here later.
 */
export const SIGNING_SECRET_VAR = 'GRATIS_SIGNING_SECRET';

/**
 * Values that are public or guessable. The one list the API checks.
 * The install scripts refuse the same words (infra/lib-env.sh,
 * infra/nas-init.py). The last one is the development value in
 * .env.example, which is public too.
 */
export const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'password',
  'devpassword',
  'admin',
  'changeme',
  'secret',
  'gratisgis',
  'dev-signing-secret-not-for-production',
]);

/** What development uses when nothing is set, as before. */
const DEV_DEFAULT = 'devpassword';

export interface EsriSigningSecret {
  /** The secret to derive the key from. */
  secret: string;
  /** True when GRATIS_SIGNING_SECRET is set; false for the MinIO fallback. */
  dedicated: boolean;
}

type Env = Record<string, string | undefined>;

/** The dedicated secret when it is set, otherwise the MinIO secret. */
export function esriSigningSecret(env: Env = process.env): EsriSigningSecret {
  const own = env.GRATIS_SIGNING_SECRET ?? '';
  if (own.trim() !== '') return { secret: own, dedicated: true };
  return { secret: env.MINIO_SECRET_KEY || DEV_DEFAULT, dedicated: false };
}

/** True when a secret is empty or a known placeholder. */
export function isWeakSecret(value: string | undefined): boolean {
  const v = (value ?? '').trim();
  return v === '' || PLACEHOLDER_SECRETS.has(v.toLowerCase());
}

/**
 * Called once by main.ts before the API listens. In production a
 * missing or placeholder signing secret stops startup: anyone could
 * sign in as any user with a token signed by a public value. When the
 * dedicated secret is not set yet, logs one warning and carries on with
 * the MinIO secret, so an upgrade never fails to start.
 */
export function checkEsriSigningSecret(logger: Pick<Logger, 'warn'>, env: Env = process.env): void {
  const own = env.GRATIS_SIGNING_SECRET ?? '';
  const dedicated = own.trim() !== '';
  const used = dedicated ? own : env.MINIO_SECRET_KEY;
  if (env.NODE_ENV === 'production' && isWeakSecret(used)) {
    const name = dedicated ? SIGNING_SECRET_VAR : `MINIO_SECRET_KEY (used because ${SIGNING_SECRET_VAR} is not set)`;
    throw new Error(
      `${name} is empty or a well-known placeholder. ` +
        'ArcGIS Pro and QGIS sign-in tokens would be signed with a public value. ' +
        `Set ${SIGNING_SECRET_VAR} to a long random value (openssl rand -base64 36), ` +
        'or run ./infra/deploy.sh again, which adds one. ' +
        'On a NAS, paste the current docker-compose.nas.yml over the app and start it again.',
    );
  }
  if (!dedicated) {
    logger.warn(
      `${SIGNING_SECRET_VAR} is not set, so ArcGIS Pro and QGIS sign-in tokens are signed with the storage (MinIO) secret. ` +
        'To give them a secret of their own, run ./infra/deploy.sh again on a server install. ' +
        'On a NAS, paste the current docker-compose.nas.yml over the app and start it again. ' +
        'Both add the secret for you.',
    );
  }
}
