// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * #156 Realtime presence + live cursors.
 *
 * Phase 1: HTTP polling (heartbeat every ~2s).
 * Phase 1.5: Nest WebSocket transport with the same roster shape;
 * HTTP remains as the durable fallback. Opaque short-lived tickets
 * are minted over the authenticated BFF so the browser never puts
 * a session JWT on the WebSocket URL.
 *
 * In-memory only: with two portal-api replicas behind a load
 * balancer, presence works within a single replica. Acceptable for
 * the small-team buyer; Redis cross-replica fanout lands later.
 */
const HEARTBEAT_TTL_MS = 5_000;
const TICKET_TTL_MS = 30_000;

/** Active member of a presence room. */
export interface PresenceMember {
  /** Stable per-tab id; minted server-side on first heartbeat
   *  for a user/connection that didn't carry one. */
  connectionId: string;
  userId: string;
  displayName: string;
  color: string;
  /** Last cursor in WGS84. Null until the client sends one. */
  cursor: { lng: number; lat: number } | null;
  /** ms-since-epoch. Server scrubs entries older than HEARTBEAT_TTL_MS. */
  lastSeenAt: number;
}

export interface PresenceRoster {
  me: PresenceMember;
  members: PresenceMember[];
}

export interface PresenceTicketIssue {
  ticket: string;
  connectionId: string;
  expiresInMs: number;
  /** Path under the portal-api origin (includes /api prefix). */
  wsPath: string;
}

interface RoomState {
  members: Map<string, PresenceMember>; // keyed by connectionId
  /** WS subscribers that want a roster push after each mutation. */
  subscribers: Set<(members: PresenceMember[]) => void>;
}

interface TicketRecord {
  user: AuthUser;
  mapId: string;
  connectionId: string;
  expiresAt: number;
}

const PALETTE: string[] = [
  '#0ea5e9', // sky
  '#f97316', // orange
  '#22c55e', // green
  '#a855f7', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // amber
  '#3b82f6', // blue
];

@Injectable()
export class RealtimeService {
  private readonly rooms = new Map<string, RoomState>();
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  /**
   * Mint a short-lived WS ticket after the same can-read check as
   * heartbeat. Single-use: consumeTicket deletes it.
   */
  async mintTicket(
    user: AuthUser,
    mapId: string,
    connectionId?: string,
  ): Promise<PresenceTicketIssue> {
    await this.assertCanRead(user, mapId);
    this.pruneTickets();
    const id =
      typeof connectionId === 'string' && connectionId.length > 0
        ? connectionId.slice(0, 80)
        : mintConnectionId(user.id);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, {
      user,
      mapId,
      connectionId: id,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return {
      ticket,
      connectionId: id,
      expiresInMs: TICKET_TTL_MS,
      wsPath: `/api/realtime/ws?mapId=${encodeURIComponent(mapId)}&ticket=${encodeURIComponent(ticket)}`,
    };
  }

  /**
   * Validate and consume a WS ticket. Returns the authenticated
   * principal + connection id bound to the map, or throws.
   */
  consumeTicket(
    ticket: string,
    mapId: string,
  ): { user: AuthUser; connectionId: string } {
    this.pruneTickets();
    const row = this.tickets.get(ticket);
    if (!row || row.mapId !== mapId || row.expiresAt < Date.now()) {
      this.tickets.delete(ticket);
      throw new UnauthorizedException('Presence ticket expired or invalid.');
    }
    this.tickets.delete(ticket);
    return { user: row.user, connectionId: row.connectionId };
  }

  /**
   * Apply a heartbeat from a viewer. Returns the active member
   * list (post-prune) so the client gets fresh state on every
   * heartbeat round-trip without needing a separate GET.
   */
  async heartbeat(
    user: AuthUser,
    mapId: string,
    input: {
      connectionId?: string;
      cursor?: { lng: number; lat: number } | null;
    },
  ): Promise<PresenceRoster> {
    await this.assertCanRead(user, mapId);
    const room = this.getOrCreate(mapId);
    this.prune(room);
    const connectionId =
      typeof input.connectionId === 'string' && input.connectionId.length > 0
        ? input.connectionId.slice(0, 80)
        : mintConnectionId(user.id);

    let cursorUpdate: { lng: number; lat: number } | null | undefined =
      undefined;
    if (input.cursor === null) {
      cursorUpdate = null;
    } else if (input.cursor && typeof input.cursor === 'object') {
      const lng = Number((input.cursor as { lng?: unknown }).lng);
      const lat = Number((input.cursor as { lat?: unknown }).lat);
      if (
        Number.isFinite(lng) &&
        Number.isFinite(lat) &&
        lng >= -180 &&
        lng <= 180 &&
        lat >= -90 &&
        lat <= 90
      ) {
        cursorUpdate = { lng, lat };
      }
    }

    const existing = room.members.get(connectionId);
    let member: PresenceMember;
    if (existing) {
      if (cursorUpdate !== undefined) existing.cursor = cursorUpdate;
      existing.lastSeenAt = Date.now();
      member = existing;
    } else {
      const displayName = await this.resolveDisplay(user);
      const color = this.nextColor(room);
      member = {
        connectionId,
        userId: user.id,
        displayName,
        color,
        cursor: cursorUpdate ?? null,
        lastSeenAt: Date.now(),
      };
      room.members.set(connectionId, member);
    }
    const members = Array.from(room.members.values());
    this.notifyRoom(room, members);
    return { me: member, members };
  }

  /**
   * Drop the viewer's presence row. Called on page unload via
   * navigator.sendBeacon so the avatar disappears immediately
   * instead of waiting out the heartbeat TTL.
   */
  async leave(
    user: AuthUser,
    mapId: string,
    connectionId: string,
  ): Promise<void> {
    await this.assertCanRead(user, mapId);
    const room = this.rooms.get(mapId);
    if (!room) return;
    const existing = room.members.get(connectionId);
    if (existing && existing.userId !== user.id) return; // can only drop your own
    room.members.delete(connectionId);
    const members = Array.from(room.members.values());
    this.notifyRoom(room, members);
    if (room.members.size === 0 && room.subscribers.size === 0) {
      this.rooms.delete(mapId);
    }
  }

  /**
   * Pure read endpoint for clients that just want the roster
   * without sending a heartbeat (e.g. an admin viewing live
   * presence stats). Most callers should use heartbeat() so the
   * round-trip both refreshes their own presence and pulls down
   * the latest roster in one shot.
   */
  async list(user: AuthUser, mapId: string): Promise<PresenceMember[]> {
    await this.assertCanRead(user, mapId);
    const room = this.rooms.get(mapId);
    if (!room) return [];
    this.prune(room);
    return Array.from(room.members.values());
  }

  /** Subscribe a WS client to roster pushes for a map room. */
  subscribe(
    mapId: string,
    listener: (members: PresenceMember[]) => void,
  ): () => void {
    const room = this.getOrCreate(mapId);
    room.subscribers.add(listener);
    return () => {
      room.subscribers.delete(listener);
      if (room.members.size === 0 && room.subscribers.size === 0) {
        this.rooms.delete(mapId);
      }
    };
  }

  // ---- helpers ----------------------------------------------------------

  private getOrCreate(mapId: string): RoomState {
    let room = this.rooms.get(mapId);
    if (!room) {
      room = { members: new Map(), subscribers: new Set() };
      this.rooms.set(mapId, room);
    }
    return room;
  }

  private prune(room: RoomState): void {
    const cutoff = Date.now() - HEARTBEAT_TTL_MS;
    for (const [id, m] of room.members) {
      if (m.lastSeenAt < cutoff) room.members.delete(id);
    }
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [k, v] of this.tickets) {
      if (v.expiresAt < now) this.tickets.delete(k);
    }
  }

  private notifyRoom(room: RoomState, members: PresenceMember[]): void {
    for (const listener of room.subscribers) {
      try {
        listener(members);
      } catch {
        /* one bad subscriber must not break the room */
      }
    }
  }

  private nextColor(room: RoomState): string {
    const used = new Set(
      Array.from(room.members.values()).map((m) => m.color.toLowerCase()),
    );
    for (const c of PALETTE) {
      if (!used.has(c.toLowerCase())) return c;
    }
    return PALETTE[room.members.size % PALETTE.length]!;
  }

  private async resolveDisplay(user: AuthUser): Promise<string> {
    const row = await this.prisma.user
      .findUnique({
        where: { id: user.id },
        select: { fullName: true, username: true },
      })
      .catch(() => null);
    const name =
      (row?.fullName && row.fullName.trim().length > 0
        ? row.fullName
        : null) ??
      row?.username ??
      user.username ??
      'Viewer';
    return name.slice(0, 80);
  }

  private async assertCanRead(user: AuthUser, mapId: string): Promise<void> {
    const item = await this.prisma.item.findFirst({
      where: { id: mapId, type: 'map', deletedAt: null },
    });
    if (!item) throw new NotFoundException('Map not found');
    const shares = await this.prisma.itemShare.findMany({
      where: { itemId: mapId },
    });
    if (!this.sharing.canRead(user, item, shares)) {
      throw new ForbiddenException('You do not have access to this map');
    }
  }
}

function mintConnectionId(userId: string): string {
  return `${userId}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
