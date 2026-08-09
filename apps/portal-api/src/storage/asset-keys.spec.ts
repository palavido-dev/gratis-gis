// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ITEM_ASSET_KIND,
  assetKeyFor,
  isAssetKeyedItemType,
  isValidAssetKey,
} from './asset-keys.js';

/**
 * These cases are the precondition for a confirmed read/delete
 * primitive, not style preferences. `data.storageKey` arrives from the
 * generic /items DTO, which validates `data` with nothing but
 * @IsObject; the @Public point-cloud proxy then reads through the key
 * with portal-api's own MinIO credentials. Before this guard, a
 * viewer-role account could create a public point_cloud item, PATCH its
 * storageKey to any object in the single shared bucket, and fetch it
 * anonymously.
 */
describe('asset-keys', () => {
  describe('isValidAssetKey', () => {
    it('accepts a key minted under the matching kind', () => {
      expect(
        isValidAssetKey(
          'item-point-cloud/8f14e45f-ceea-467a-9a3e-6b5d7c9f0a11',
          'item-point-cloud',
        ),
      ).toBe(true);
    });

    it('rejects a key belonging to a different kind', () => {
      // The exfiltration case: feedback screenshots are uploaded
      // through an anonymous endpoint and are meant for admin triage
      // only, so they must never be reachable through an item proxy.
      expect(
        isValidAssetKey(
          'feedback-screenshot/8f14e45f-ceea-467a-9a3e-6b5d7c9f0a11',
          'item-point-cloud',
        ),
      ).toBe(false);
      expect(
        isValidAssetKey('item-file/abc', 'item-point-cloud'),
      ).toBe(false);
      expect(
        isValidAssetKey('feature-attachment/abc', 'item-tile-layer'),
      ).toBe(false);
    });

    it('rejects a prefix match that is not a segment boundary', () => {
      // "item-point-cloud-evil/..." must not pass as
      // "item-point-cloud/..."; the check appends the slash for this.
      expect(
        isValidAssetKey('item-point-cloud-evil/x', 'item-point-cloud'),
      ).toBe(false);
    });

    it('rejects traversal and empty segments', () => {
      for (const bad of [
        'item-point-cloud/../feedback-screenshot/x',
        'item-point-cloud/a/../../item-file/x',
        'item-point-cloud/./x',
        'item-point-cloud//x',
        'item-point-cloud/',
      ]) {
        expect(isValidAssetKey(bad, 'item-point-cloud')).toBe(false);
      }
    });

    it('rejects non-strings and the empty string', () => {
      for (const bad of [undefined, null, 42, {}, [], '']) {
        expect(isValidAssetKey(bad, 'item-file')).toBe(false);
      }
    });

    it('allows sub-paths under the right prefix', () => {
      // Mosaic sources legitimately live deeper than <kind>/<uuid>.
      expect(
        isValidAssetKey('item-tile-layer/abc/0/1/2.png', 'item-tile-layer'),
      ).toBe(true);
    });
  });

  describe('isAssetKeyedItemType', () => {
    it('covers exactly the three types that name an object', () => {
      expect(Object.keys(ITEM_ASSET_KIND).sort()).toEqual([
        'file',
        'point_cloud',
        'tile_layer',
      ]);
      for (const t of ['file', 'tile_layer', 'point_cloud']) {
        expect(isAssetKeyedItemType(t)).toBe(true);
      }
      for (const t of ['map', 'data_layer', 'script', 'web_app']) {
        expect(isAssetKeyedItemType(t)).toBe(false);
      }
    });
  });

  describe('assetKeyFor', () => {
    it('passes through item types that name no object', () => {
      // A map's data legitimately carries all sorts of keys; the guard
      // must not touch it.
      expect(assetKeyFor('map', 'anything/at/all')).toEqual({
        ok: true,
        key: null,
      });
    });

    it('treats absent and empty as "no upload yet" rather than invalid', () => {
      // The file-item UI clears an upload by writing storageKey: ''.
      for (const v of [undefined, null, '']) {
        expect(assetKeyFor('file', v)).toEqual({ ok: true, key: null });
      }
    });

    it('accepts a legitimate presigned key for each type', () => {
      expect(assetKeyFor('file', 'item-file/u1')).toEqual({
        ok: true,
        key: 'item-file/u1',
      });
      expect(assetKeyFor('tile_layer', 'item-tile-layer/u2')).toEqual({
        ok: true,
        key: 'item-tile-layer/u2',
      });
      expect(assetKeyFor('point_cloud', 'item-point-cloud/u3')).toEqual({
        ok: true,
        key: 'item-point-cloud/u3',
      });
    });

    it('rejects the cross-kind swap that made this exploitable', () => {
      expect(assetKeyFor('point_cloud', 'feedback-screenshot/u1')).toEqual({
        ok: false,
      });
      expect(assetKeyFor('point_cloud', 'item-file/u1')).toEqual({ ok: false });
      expect(assetKeyFor('file', 'item-point-cloud/u1')).toEqual({ ok: false });
    });
  });
});
