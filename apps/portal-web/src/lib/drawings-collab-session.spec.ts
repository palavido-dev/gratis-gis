// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import type { DrawingFeature } from '@gratis-gis/shared-types';
import { openDrawingsCollabSession } from './drawings-collab-session';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('openDrawingsCollabSession', () => {
  const realFetch = global.fetch;
  beforeAll(() => {
    (globalThis as unknown as { window: unknown }).window = {
      location: { protocol: 'https:', host: 'portal.test' },
    };
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  beforeEach(() => {
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({ ticket: 't', role: 'writer', wsPath: '/ws/drawings' }),
      ),
    ) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('reports a dropped socket and stops feeding stale features back', async () => {
    const onFeatures = jest.fn();
    const onClosed = jest.fn();
    const session = await openDrawingsCollabSession({
      mapId: 'm',
      drawingSetId: 's',
      onFeatures,
      onClosed,
    });
    expect(session).not.toBeNull();
    const feature = { id: 'f1' } as DrawingFeature;
    session!.upsertFeature(feature);
    expect(onFeatures).toHaveBeenCalledTimes(1);

    // The server or the network ends the socket.
    FakeSocket.last!.readyState = 3;
    FakeSocket.last!.onclose?.();
    expect(onClosed).toHaveBeenCalledTimes(1);

    session!.upsertFeature({ id: 'f2' } as DrawingFeature);
    expect(onFeatures).toHaveBeenCalledTimes(1);
  });

  it('does not report a close the caller asked for', async () => {
    const onClosed = jest.fn();
    const session = await openDrawingsCollabSession({
      mapId: 'm',
      drawingSetId: 's',
      onFeatures: () => undefined,
      onClosed,
    });
    session!.close();
    expect(onClosed).not.toHaveBeenCalled();
  });
});
