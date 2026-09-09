// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * Every offline message code, rendered.
 *
 * The point of storing codes instead of English is that the text is
 * produced later, somewhere else, by whoever reads the row. That only
 * works if every code the producers can write has a catalog entry whose
 * placeholders match the params, and nothing checks that at compile
 * time: a mismatch ships as the literal `{layer}` on a phone in the
 * field, or as the raw key `offlineMessage.download.layerCached`.
 *
 * So this walks the whole list. `SAMPLES` is pinned to
 * `OFFLINE_MESSAGE_CODES`, so a new code with no sample fails here
 * rather than going unrendered.
 */
import {
  OFFLINE_MESSAGE_CODES,
  type OfflineMessage,
} from '@gratis-gis/shared-types';

import { t as translate, type Translator } from './i18n';
import { formatOfflineMessage, formatOfflineMessages } from './offline-message';

/** English, explicitly: this suite is about the catalog every other
 *  locale falls back to. */
const t: Translator = (key, params) => translate(key, params, 'en');

/** One realistic message per code, with the params its producer sends. */
const SAMPLES: OfflineMessage[] = [
  { code: 'legacy.text', params: { text: 'Nest (HTTP 500)' } },
  { code: 'download.estimating' },
  { code: 'download.estimated', params: { bytes: 12_582_912 } },
  { code: 'download.fetchingLayer', params: { layer: 'Nest' } },
  { code: 'download.layerCached', params: { layer: 'Nest', count: 12 } },
  { code: 'download.layerHttpError', params: { layer: 'Nest', status: 500 } },
  { code: 'download.layerMalformed', params: { layer: 'Nest' } },
  { code: 'download.layerOutOfSpace', params: { layer: 'Nest' } },
  {
    code: 'download.layerFailed',
    params: { layer: 'Nest', error: 'Failed to fetch' },
  },
  { code: 'download.fetchingForm', params: { form: '9f3a1b2c' } },
  { code: 'download.formHttpError', params: { form: '9f3a1b2c', status: 404 } },
  { code: 'download.formNoSchema', params: { form: '9f3a1b2c' } },
  { code: 'download.formFailed', params: { form: '9f3a1b2c' } },
  { code: 'download.fetchingPickList', params: { pickList: '7e2d0a11' } },
  {
    code: 'download.pickListHttpError',
    params: { pickList: '7e2d0a11', status: 403 },
  },
  { code: 'download.pickListNoData', params: { pickList: '7e2d0a11' } },
  { code: 'download.pickListFailed', params: { pickList: '7e2d0a11' } },
  { code: 'download.basemapOne' },
  { code: 'download.basemapNth', params: { index: 2, count: 3 } },
  { code: 'download.basemapOnePercent', params: { percent: 45 } },
  {
    code: 'download.basemapNthPercent',
    params: { index: 2, count: 3, percent: 45 },
  },
  { code: 'download.basemapOneMegabytes', params: { megabytes: '10.2' } },
  {
    code: 'download.basemapNthMegabytes',
    params: { index: 2, count: 3, megabytes: '10.2' },
  },
  { code: 'download.basemapOutOfSpace' },
  { code: 'download.basemapFailed', params: { error: 'Failed to fetch' } },
  { code: 'download.basemapAreaMissing', params: { area: 'a1b2c3d4' } },
  { code: 'download.cachingTiles' },
  { code: 'download.tilesProgress', params: { fetched: 120, total: 4000 } },
  {
    code: 'download.tilesRefused',
    params: { reason: "OpenStreetMap's tile policy prohibits offline downloads." },
  },
  { code: 'download.tilesRefusedGeneric' },
  { code: 'download.tilesCached', params: { fetched: 3900, failed: 100 } },
  { code: 'download.tilesOutOfSpace' },
  { code: 'download.tilesFailed', params: { error: 'Failed to fetch' } },
  { code: 'download.tilesMissing', params: { count: 100 } },
  { code: 'download.tilesMissingAll' },
  { code: 'download.saving' },
  {
    code: 'download.done',
    params: { layers: 3, features: 12, forms: 1, pickLists: 2 },
  },
  {
    code: 'download.donePartial',
    params: {
      layers: 3,
      features: 12,
      forms: 1,
      pickLists: 2,
      missing: [{ code: 'download.layerMalformed', params: { layer: 'Nest' } }],
    },
  },
  {
    code: 'download.donePartialOutOfSpace',
    params: {
      missing: [{ code: 'download.tilesMissing', params: { count: 40 } }],
    },
  },
  { code: 'download.quotaRefused' },
  { code: 'download.stopped' },
  { code: 'download.failed' },
  { code: 'sync.networkUnavailable' },
  {
    code: 'sync.networkUnavailableDetail',
    params: { error: 'Failed to fetch' },
  },
  { code: 'sync.unknownOp', params: { op: 'upsert' } },
  {
    code: 'sync.fileTooLarge',
    params: { fileName: 'photo.jpg', sizeMb: '18.4', limitMb: '10' },
  },
  {
    code: 'sync.serverRefused',
    params: { serverMessage: 'Depth must be a number.' },
  },
  {
    code: 'sync.serverRefusedWithStatus',
    params: { serverMessage: 'boom', status: 500 },
  },
  { code: 'sync.requestFailed', params: { status: 500 } },
  { code: 'sync.attachmentPresignFailed', params: { status: 503 } },
  { code: 'sync.attachmentUploadFailed', params: { status: 503 } },
  { code: 'sync.attachmentRegisterFailed', params: { status: 503 } },
  { code: 'sync.queueReadFailed' },
  { code: 'sync.unexpected', params: { error: 'InvalidStateError' } },
];

describe('formatOfflineMessage', () => {
  it('has a sample for every code the producers can write', () => {
    expect(SAMPLES.map((s) => s.code).sort()).toEqual(
      [...OFFLINE_MESSAGE_CODES].sort(),
    );
  });

  it.each(SAMPLES.map((s) => [s.code, s] as const))(
    'renders %s with no placeholder left behind',
    (code, message) => {
      const rendered = formatOfflineMessage(t, message);
      expect(rendered.length).toBeGreaterThan(0);
      // A missing catalog entry renders as the key itself, which is the
      // failure mode this suite exists to catch.
      expect(rendered).not.toMatch(
        /^(offlineMessage|fieldOffline|fieldRuntime|offlineBasemap)\./,
      );
      // A `{param}` the catalog names and the producer does not send is
      // printed literally by the interpolator.
      expect(rendered).not.toMatch(/[{}]/);
      void code;
    },
  );

  it('passes legacy text through exactly as it was stored', () => {
    // A row written before schema v4 carries whatever English the drain
    // composed at the time. It is still the truest thing we have about
    // that edit, so it is shown, not translated and not dropped.
    expect(
      formatOfflineMessage(t, {
        code: 'legacy.text',
        params: { text: 'POST failed (500). boom' },
      }),
    ).toBe('POST failed (500). boom');
  });

  it('names a code from a newer client rather than rendering nothing', () => {
    // The device is on a build this portal has never seen. Blanking the
    // line would destroy the only record of why an edit is stuck.
    const rendered = formatOfflineMessage(t, {
      code: 'sync.somethingNewer',
      params: { status: 418 },
    });
    expect(rendered).toContain('sync.somethingNewer');
    expect(rendered).not.toMatch(/[{}]/);
  });

  it('carries the server sentence through untranslated', () => {
    // The validator named the field and what it would not accept. No
    // client can translate that, and replacing it with something vaguer
    // is how "Save failed (400)" used to reach the field.
    expect(
      formatOfflineMessage(t, {
        code: 'sync.serverRefused',
        params: { serverMessage: 'Depth is a number field; "n/a" is not.' },
      }),
    ).toBe('Depth is a number field; "n/a" is not.');
  });

  it('leaves the zero counts out of the download summary', () => {
    // A brand-new deployment caches a schema, a form and no features at
    // all. "Cached 0 features, 0 forms, 0 pick lists" read like a
    // download that did nothing, which is why the breakdown is built
    // here rather than by the producer.
    const empty = formatOfflineMessage(t, {
      code: 'download.done',
      params: { layers: 1, features: 0, forms: 0, pickLists: 0 },
    });
    expect(empty).toContain('1 layer');
    expect(empty).not.toContain('0');

    const full = formatOfflineMessage(t, {
      code: 'download.done',
      params: { layers: 2, features: 1, forms: 0, pickLists: 3 },
    });
    expect(full).toContain('2 layers');
    expect(full).toContain('1 feature');
    expect(full).toContain('3 pick lists');
    expect(full).not.toContain('form');
  });

  it('names the first few shortfalls and counts the rest', () => {
    const missing: OfflineMessage[] = [
      { code: 'download.layerMalformed', params: { layer: 'Nest' } },
      { code: 'download.formNoSchema', params: { form: 'aaaa1111' } },
      { code: 'download.pickListNoData', params: { pickList: 'bbbb2222' } },
      { code: 'download.tilesMissing', params: { count: 12 } },
      { code: 'download.tilesMissingAll' },
    ];
    const rendered = formatOfflineMessage(t, {
      code: 'download.donePartial',
      params: { layers: 1, features: 0, forms: 0, pickLists: 0, missing },
    });
    expect(rendered).toContain('Nest');
    expect(rendered).toContain('aaaa1111');
    expect(rendered).toContain('bbbb2222');
    // Two past the three it names, so the line cannot grow without
    // bound on a download that went badly wrong.
    expect(rendered).toContain('2 more');
    expect(rendered).not.toMatch(/[{}]/);
  });

  it('renders a shortfall list on its own for the panel line', () => {
    const rendered = formatOfflineMessages(
      t,
      [
        { code: 'download.layerMalformed', params: { layer: 'Nest' } },
        { code: 'download.tilesMissingAll' },
        { code: 'download.formNoSchema', params: { form: 'aaaa1111' } },
      ],
      2,
    );
    expect(rendered).toContain('Nest');
    expect(rendered).toContain('1 more');
    expect(rendered).not.toContain('aaaa1111');
  });

  it('drops a param the interpolator could not use anyway', () => {
    // Rows are read back off a device, so a param can be a shape the
    // catalog cannot substitute. Dropping it beats `[object Object]`
    // in the middle of a sentence.
    const rendered = formatOfflineMessage(t, {
      code: 'download.layerCached',
      params: { layer: 'Nest', count: 4, extra: { nested: true } },
    } as unknown as OfflineMessage);
    expect(rendered).toContain('Nest');
    expect(rendered).not.toContain('object Object');
  });
});
