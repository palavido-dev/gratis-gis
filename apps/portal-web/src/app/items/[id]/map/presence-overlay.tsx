// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Presence overlay (#156 Phase 1).
 *
 * Renders "who's currently viewing this map" as avatar chips in
 * the map toolbar plus each viewer's cursor position on the
 * canvas (when they've shared one). Implements the third leg of
 * the Figma-for-maps collaboration story alongside markup (#154)
 * and threaded comments (#155).
 *
 * Phase 1 uses HTTP polling: the client POSTs a heartbeat with
 * the local viewer's cursor lat/lng every 2 seconds and renders
 * the server-returned roster of active members (TTL-pruned on
 * the server at 5 seconds). Phase 1.5 swaps the transport to a
 * Nest WebSocket gateway behind a Caddy WS route for sub-second
 * cursor latency; the visible UX stays the same.
 *
 * The cursor projection uses MapLibre's `map.project([lng, lat])`
 * helper to convert WGS84 to screen pixels. We re-project the
 * stored cursors on every camera move so cursors track the map
 * even when nobody's heartbeat has fired in the meantime.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type maplibregl from 'maplibre-gl';

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
   * canvas. Optional — when omitted, the chips render in a
   * top-left floating box.
   */
  chipsContainer?: HTMLElement | null;
}

const HEARTBEAT_INTERVAL_MS = 2_000;
const CURSOR_THROTTLE_MS = 250;

export function PresenceOverlay({
  mapId,
  currentUser,
  mapLibre,
  chipsContainer,
}: Props) {
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const lastCursorRef = useRef<{ lng: number; lat: number } | null>(null);
  const lastSentRef = useRef<number>(0);
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

  // Heartbeat loop.
  useEffect(() => {
    if (!currentUser) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      const now = Date.now();
      // Throttle cursor payload to CURSOR_THROTTLE_MS so a fast
      // mouse motion doesn't fire one heartbeat per pixel.
      const cursorToSend =
        now - lastSentRef.current >= CURSOR_THROTTLE_MS
          ? lastCursorRef.current
          : undefined;
      lastSentRef.current = now;
      try {
        const body: Record<string, unknown> = {};
        if (connectionId) body.connectionId = connectionId;
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
        if (!alive) return;
        if (!connectionId && data.me?.connectionId) {
          setConnectionId(data.me.connectionId);
        }
        setMembers(data.members);
      } catch {
        // Swallow; the next heartbeat will try again. Presence
        // dropping out for a few seconds is the right failure mode.
      }
    };
    // Fire one immediately on mount, then poll.
    void tick();
    const interval = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [currentUser, mapId, connectionId]);

  // Best-effort drop on tab close so the user's chip disappears
  // immediately on navigation rather than waiting out the TTL.
  useEffect(() => {
    if (!currentUser || !connectionId) return;
    const handler = () => {
      try {
        const data = new Blob([], { type: 'application/json' });
        navigator.sendBeacon(
          `/api/portal/realtime/maps/${mapId}/presence/${encodeURIComponent(connectionId)}`,
          data,
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
    // cameraTick is a re-render trigger; reference it so the
    // optimizer keeps it in the dep list.
    void cameraTick;
    if (!mapLibre) return [] as Array<{ member: PresenceMember; x: number; y: number }>;
    const out: Array<{ member: PresenceMember; x: number; y: number }> = [];
    for (const m of members) {
      if (!m.cursor) continue;
      if (m.connectionId === connectionId) continue; // don't render my own cursor
      const p = mapLibre.project([m.cursor.lng, m.cursor.lat]);
      out.push({ member: m, x: p.x, y: p.y });
    }
    return out;
  }, [members, connectionId, mapLibre, cameraTick]);

  return (
    <>
      {/* Cursor markers. Absolute-positioned over the canvas; the
          canvas wrapper has position: relative already. */}
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
            className="ml-2 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-2xs font-medium text-white shadow"
            style={{ backgroundColor: member.color }}
          >
            {member.displayName}
          </span>
        </div>
      ))}
      {/* Avatar strip. When the parent supplies chipsContainer
          (the BuilderShell toolbar's left side, next to the
          canvas pane toggles + Save button), we portal into it so
          the chips sit in the toolbar instead of floating over
          the canvas where they used to overlap the MapLibre zoom
          + compass controls. With no container, we fall back to
          the canvas-overlay rendering for callers that don't have
          a toolbar slot (preview surfaces, embedded readers). */}
      {currentUser && members.length > 0 ? renderChipStrip(
        chipsContainer,
        members,
        connectionId,
      ) : null}
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
          className="flex h-6 w-6 items-center justify-center rounded-full border border-white text-2xs font-semibold text-white shadow"
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
  // Fallback: canvas overlay (the pre-portal behavior). The
  // pointer-events-none + absolute positioning is preserved so
  // legacy callers don't regress.
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
