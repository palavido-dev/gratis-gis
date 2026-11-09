// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotificationType } from '@prisma/client';

import { getTypeMeta } from './notification-types.js';
import { SAMPLE_PAYLOADS } from './sample-payloads.js';
import { renderNotification } from './templates.js';

/**
 * A type missing from the catalog cannot be muted or customised: the
 * preferences page never lists it and the template editor answers
 * 400. Every enum value needs meta, a sample payload and a renderer.
 */
describe('notification catalog', () => {
  const types = Object.values(NotificationType);

  it.each(types)('%s has catalog meta', (type) => {
    expect(getTypeMeta(type)).toBeDefined();
  });

  it.each(types)('%s has a sample payload that renders', (type) => {
    const payload = SAMPLE_PAYLOADS[type];
    expect(payload).toBeDefined();
    const out = renderNotification(type, payload, {
      orgLabel: 'Demo',
      baseUrl: 'https://portal.example',
    });
    expect(out?.subject.length ?? 0).toBeGreaterThan(0);
  });
});
