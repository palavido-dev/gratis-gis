// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Size cap for image uploads (item, group and org thumbnails, avatars,
 * hero images). portal-api refuses a presign above it; clients use the
 * same figure for their early "too large" answer, so the two cannot
 * drift apart again (the asset picker said 10 MB while the server
 * refused anything over 5).
 */
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_UPLOAD_MAX_MB = IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024);
