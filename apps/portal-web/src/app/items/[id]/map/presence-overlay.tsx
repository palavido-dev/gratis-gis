// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Presence overlay (#156 Phase 1 + 1.5).
 *
 * Renders "who's currently viewing this map" as avatar chips in
 * the map toolbar plus each viewer's cursor position on the
 * canvas (when they've shared one).
 *
 * Transport: try a Nest WebSocket (ticket minted over the BFF so
 * the session JWT never lands on the WS URL). If the socket fails
 * to open or drops, fall back to the Phase 1 HTTP heartbeat poll
 * every 2 seconds. Visible UX is the same either way.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as maplibregl from 'maplibre-gl';

interface PresenceMember {
  connectionId: string;
  userId: string;
  displayName: string;
  color: string;
  cursor: { lng: number; lat: number } | null;
  lastSeenAt: number;
}

interface HeartbeatResponse {
  me: PresenceMember;
  members: PresenceMember[];
}

interface TicketResponse {
  ticket: string;
  connectionId: string;
  expiresInMs: number;
  wsPath: string;
}

interface Props {
  /** UUID of the map item this overlay is connected to. */
  mapId: string;
  /** Current signed-in user. Null disables presence (no anon presence in Phase 1). */
  currentUser: { id: string; displayName: string } | null;
  /** MapLibre instance handle for cursor projection. Optional so
   *  the overlay can mount before the canvas is ready and pick
   *  the map up later via a ref callback. */
  mapLibre: maplibregl.Map | null;
  /**
   * Where to render the avatar strip. The map editor passes a
   * portal target (the right side of the toolbar) so the chips
   * appear next to the Save button rather than floating over the
   * canvas. Optional - when omitted, the chips render in a
   * top-left floating box.
   */
  chipsContainer?: HTMLElement | null;
}

const HEARTBEAT_INTERVAL_MS = 2_000;
const CURSOR_THROTTLE_MS = 250;
const WS_HEARTBEAT_INTERVAL_MS = 2_000;

export function PresenceOverlay({
  mapId,
  currentUser,
  mapLibre,
  chipsContainer,
}: Props) {
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [transport, setTransport] = useState<'ws' | 'http'>('http');
  const lastCursorRef = useRef<{ lng: number; lat: number } | null>(null);
  const lastSentRef = useRef<number>(0);
  const connectionIdRef = useRef<string | null>(null);
  connectionIdRef.current = connectionId;
  const wsRef = useRef<WebSocket | null>(null);
  // Force re-render on map move so we re-project cursors.
  const [cameraTick, setCameraTick] = useState(0);

  // Track mouse position over the map canvas.
  useEffect(() => {
    if (!mapLibre || !currentUser) return;
    const handler = (e: maplibregl.MapMouseEvent) => {
      lastCursorRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    };
    const onLeave = () => {
      lastCursorRef.current = null;
    };
    mapLibre.on('mousemove', handler);
    mapLibre.on('mouseout', onLeave);
    return () => {
      mapLibre.off('mousemove', handler);
      mapLibre.off('mouseout', onLeave);
    };
  }, [mapLibre, currentUser]);

  // Re-render on camera moves so other people's cursors track the map.
  useEffect(() => {
    if (!mapLibre) return;
    const handler = () => setCameraTick((t) => t + 1);
    mapLibre.on('move', handler);
    return () => {
      mapLibre.off('move', handler);
    };
  }, [mapLibre]);

  const applyRoster = useCallback((next: PresenceMember[]) => {
    setMembers(next);
  }, []);

  // Prefer WebSocket; fall back to HTTP poll on failure.
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let wsHeartbeat: ReturnType<typeof setInterval> | null = null;
    let cursorTimer: ReturnType<typeof setInterval> | null = null;

    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const httpHeartbeat = async () => {
      if (cancelled) return;
      const now = Date.now();
      const cursorToSend =
        now - lastSentRef.current >= CURSOR_THROTTLE_MS
          ? lastCursorRef.current
          : undefined;
      lastSentRef.current = now;
      try {
        const body: Record<string, unknown> = {};
        if (connectionIdRef.current) body.connectionId = connectionIdRef.current;
        if (cursorToSend !== undefined) body.cursor = cursorToSend;
        const res = await fetch(
          `/api/portal/realtime/maps/${mapId}/presence/heartbeat`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as HeartbeatResponse;
        if (cancelled) return;
        if (!connectionIdRef.current && data.me?.connectionId) {
          setConnectionId(data.me.connectionId);
        }
        applyRoster(data.members);
      } catch {
        /* next poll retries */
      }
    };

    const startHttpFallback = () => {
      if (cancelled) return;
      setTransport('http');
      stopPoll();
      void httpHeartbeat();
      pollTimer = setInterval(httpHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const startWs = async () => {
      try {
        const res = await fetch(
          `/api/portal/realtime/maps/${mapId}/presence/ticket`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...(connectionIdRef.current
                ? { connectionId: connectionIdRef.current }
                : {}),
            }),
          },
        );
        if (!res.ok) throw new Error(`ticket ${res.status}`);
        const ticket = (await res.json()) as TicketResponse;
        if (cancelled) return;
        setConnectionId(ticket.connectionId);

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${window.location.host}${ticket.wsPath}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) {
            ws.close();
            return;
          }
          setTransport('ws');
          stopPoll();
          wsHeartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'heartbeat' }));
            }
          }, WS_HEARTBEAT_INTERVAL_MS);
          cursorTimer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const now = Date.now();
            if (now - lastSentRef.current < CURSOR_THROTTLE_MS) return;
            lastSentRef.current = now;
            ws.send(
              JSON.stringify({
                type: 'cursor',
                cursor: lastCursorRef.current,
              }),
            );
          }, CURSOR_THROTTLE_MS);
        };

        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as {
              type?: string;
              members?: PresenceMember[];
            };
            if (msg.type === 'roster' && Array.isArray(msg.members)) {
              applyRoster(msg.members);
            }
          } catch {
            /* ignore malformed */
          }
        };

        ws.onerror = () => {
          /* onclose handles fallback */
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (wsHeartbeat) clearInterval(wsHeartbeat);
          if (cursorTimer) clearInterval(cursorTimer);
          if (!cancelled) startHttpFallback();
        };
      } catch {
        if (!cancelled) startHttpFallback();
      }
    };

    void startWs();

    return () => {
      cancelled = true;
      stopPoll();
      if (wsHeartbeat) clearInterval(wsHeartbeat);
      if (cursorTimer) clearInterval(cursorTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'leave' }));
        } catch {
          /* ignore */
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [currentUser, mapId, applyRoster]);

  // Best-effort drop on tab close (beacon can only POST).
  useEffect(() => {
    if (!currentUser || !connectionId) return;
    const handler = () => {
      try {
        const body = new Blob(
          [JSON.stringify({ connectionId })],
          { type: 'application/json' },
        );
        navigator.sendBeacon(
          `/api/portal/realtime/maps/${mapId}/presence/leave`,
          body,
        );
      } catch {
        // ignore
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [currentUser, mapId, connectionId]);

  // Projected cursor positions for everyone except me.
  const cursors = useMemo(() => {
    void cameraTick;
    void transport;
    if (!mapLibre) return [] as Array<{ member: PresenceMember; x: number; y: number }>;
    const out: Array<{ member: PresenceMember; x: number; y: number }> = [];
    for (const m of members) {
      if (!m.cursor) continue;
      if (m.connectionId === connectionId) continue;
      const p = mapLibre.project([m.cursor.lng, m.cursor.lat]);
      out.push({ member: m, x: p.x, y: p.y });
    }
    return out;
  }, [members, connectionId, mapLibre, cameraTick, transport]);

  return (
    <>
      {cursors.map(({ member, x, y }) => (
        <div
          key={member.connectionId}
          className="pointer-events-none absolute z-20"
          style={{ left: x, top: y, transform: 'translate(-2px, -2px)' }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="rgba(0,0,0,0.4)"
            strokeWidth="0.5"
          >
            <path d="M2 2 L2 14 L6 11 L8 16 L10 15 L8 10 L13 10 Z" fill={member.color} />
          </svg>
          <span
            className="ml-2 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-2xs font-medium text-white shadow-xs"
            style={{ backgroundColor: member.color }}
          >
            {member.displayName}
          </span>
        </div>
      ))}
      {currentUser && members.length > 0
        ? renderChipStrip(chipsContainer, members, connectionId)
        : null}
    </>
  );
}

function renderChipStrip(
  container: HTMLElement | null | undefined,
  members: PresenceMember[],
  connectionId: string | null,
) {
  const strip = (
    <div className="flex items-center gap-1">
      {members.map((m) => (
        <div
          key={m.connectionId}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-white text-2xs font-semibold text-white shadow-xs"
          style={{ backgroundColor: m.color }}
          title={
            m.connectionId === connectionId
              ? `${m.displayName} (you)`
              : m.displayName
          }
        >
          {initials(m.displayName)}
        </div>
      ))}
    </div>
  );
  if (container) {
    return createPortal(strip, container);
  }
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-20">
      {strip}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0]!.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
