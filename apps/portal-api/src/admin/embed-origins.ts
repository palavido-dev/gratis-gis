// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeEmbedOrigins } from '@gratis-gis/shared-types';

import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Admin allow-list of sites the Embed widget may frame (review
 * 28b-5). Stored as one platform-wide system_setting row; a
 * deployment serves one organization. portal-web reads the list
 * through GET /public/embed-origins and adds it to `frame-src` on app
 * runtime pages only. Every other page keeps `frame-src 'self' blob:`.
 */
export const EMBED_ORIGINS_KEY = 'embed_origins';

type SettingsPrisma = Pick<PrismaService, 'systemSetting'>;

/** The saved list, normalized again on read so a hand-edited row
 *  can never put a stray token into the CSP. */
export async function readEmbedOrigins(prisma: SettingsPrisma): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: EMBED_ORIGINS_KEY },
  });
  const value = row?.value as { origins?: unknown } | null | undefined;
  const list = Array.isArray(value?.origins)
    ? value.origins.filter((o): o is string => typeof o === 'string')
    : [];
  return normalizeEmbedOrigins(list).origins;
}

export async function writeEmbedOrigins(
  prisma: SettingsPrisma,
  origins: string[],
  actorId: string,
): Promise<string[]> {
  await prisma.systemSetting.upsert({
    where: { key: EMBED_ORIGINS_KEY },
    create: { key: EMBED_ORIGINS_KEY, value: { origins }, updatedBy: actorId },
    update: { value: { origins }, updatedBy: actorId },
  });
  return origins;
}
