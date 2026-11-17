// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Browser helper for drawings CRDT rooms (R1-presence-crdt).
 *
 * Mints a ticket over the portal BFF, opens the drawings-ws socket,
 * and keeps a local Y.Doc in sync. Callers push feature upserts /
 * deletes; on remote change they receive the full feature list.
 */
import * as Y from 'yjs';
import type { DrawingFeature } from '@gratis-gis/shared-types';

export type CollabRole = 'writer' | 'observer';

export interface DrawingsCollabSession {
  role: CollabRole;
  /** Replace or insert a feature (writers only). */
  upsertFeature: (feature: DrawingFeature) => void;
  /** Remove a feature by id (writers only). */
  deleteFeature: (featureId: string) => void;
  /** Current features from the Y.Doc. */
  getFeatures: () => DrawingFeature[];
  close: () => void;
}

function wsUrlFromPath(wsPath: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${wsPath}`;
}

export async function openDrawingsCollabSession(args: {
  mapId: string;
  drawingSetId: string;
  onFeatures: (features: DrawingFeature[]) => void;
  onError?: (message: string) => void;
  /**
   * The socket closed without the caller asking (sleep, proxy reload,
   * idle timeout). The session is dead from then on: drop it and
   * open a new one, whose sync brings back what changed meanwhile.
   */
  onClosed?: () => void;
}): Promise<DrawingsCollabSession | null> {
  const ticketRes = await fetch(
    `/api/portal/realtime/maps/${encodeURIComponent(args.mapId)}/presence/drawings-ticket`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drawingSetId: args.drawingSetId }),
    },
  );
  if (!ticketRes.ok) return null;
  const issued = (await ticketRes.json()) as {
    ticket: string;
    role: CollabRole;
    wsPath: string;
  };

  const doc = new Y.Doc();
  const features = doc.getMap<string>('features');
  let socket: WebSocket | null = null;
  let closed = false;
  let applyingRemote = false;

  const emit = () => {
    const out: DrawingFeature[] = [];
    features.forEach((raw) => {
      try {
        const parsed = JSON.parse(raw) as DrawingFeature;
        if (parsed?.id) out.push(parsed);
      } catch {
        /* skip */
      }
    });
    args.onFeatures(out);
  };

  // Once the socket is gone the doc no longer hears remote changes,
  // so its list is stale. Emitting it would put that stale list back
  // into the panel, and the next REST save would then drop shapes
  // other people added meanwhile.
  features.observe(() => {
    if (!applyingRemote && !closed) emit();
  });

  const sendUpdate = (update: Uint8Array) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (issued.role !== 'writer') return;
    let bin = '';
    for (let i = 0; i < update.length; i++) {
      bin += String.fromCharCode(update[i]!);
    }
    socket.send(
      JSON.stringify({
        type: 'update',
        update: btoa(bin),
      }),
    );
  };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote' || closed) return;
    sendUpdate(update);
  });

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrlFromPath(issued.wsPath));
    socket = ws;
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('drawings-ws failed'));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          update?: string;
          message?: string;
        };
        if (msg.type === 'error') {
          args.onError?.(msg.message ?? 'collab error');
          return;
        }
        if (
          (msg.type === 'sync' || msg.type === 'update') &&
          typeof msg.update === 'string'
        ) {
          const bytes = Uint8Array.from(atob(msg.update), (c) =>
            c.charCodeAt(0),
          );
          applyingRemote = true;
          try {
            Y.applyUpdate(doc, bytes, 'remote');
            emit();
          } finally {
            applyingRemote = false;
          }
        }
      } catch {
        /* ignore bad frames */
      }
    };
    ws.onclose = () => {
      if (closed) return; // close() asked for it
      closed = true;
      args.onClosed?.();
    };
  });

  return {
    role: issued.role,
    upsertFeature(feature) {
      if (issued.role !== 'writer' || closed) return;
      features.set(feature.id, JSON.stringify(feature));
    },
    deleteFeature(featureId) {
      if (issued.role !== 'writer' || closed) return;
      features.delete(featureId);
    },
    getFeatures() {
      const out: DrawingFeature[] = [];
      features.forEach((raw) => {
        try {
          const parsed = JSON.parse(raw) as DrawingFeature;
          if (parsed?.id) out.push(parsed);
        } catch {
          /* skip */
        }
      });
      return out;
    },
    close() {
      closed = true;
      try {
        socket?.send(JSON.stringify({ type: 'leave' }));
      } catch {
        /* ignore */
      }
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      doc.destroy();
    },
  };
}
