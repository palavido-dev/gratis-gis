// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import type { DrawingFeature } from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DrawingsService } from '../items/drawings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import { DRAWINGS_WS_MAX_UPDATES_PER_SEC } from './drawings-collab-frame.js';

/**
 * Ephemeral Yjs rooms for markup co-editing
 * (R1-presence-crdt / presence-crdt-defaults-2026-11-03).
 *
 * Signed-in writers (set author or map editor) and canRead observers.
 * Source of truth remains `item.data.drawings`; rooms snapshot back
 * on a debounce and on disconnect. In-memory only (no Redis).
 */
const TICKET_TTL_MS = 30_000;
const SNAPSHOT_DEBOUNCE_MS = 1_500;
const ROOM_IDLE_MS = 60_000;

export type CollabRole = 'writer' | 'observer';

export interface CollabTicketIssue {
  ticket: string;
  connectionId: string;
  role: CollabRole;
  expiresInMs: number;
  wsPath: string;
}

interface CollabTicketRecord {
  user: AuthUser;
  mapId: string;
  drawingSetId: string;
  role: CollabRole;
  connectionId: string;
  expiresAt: number;
}

interface Peer {
  connectionId: string;
  user: AuthUser;
  role: CollabRole;
  send: (msg: unknown) => void;
  updateTimestamps: number[];
}

interface CollabRoom {
  mapId: string;
  drawingSetId: string;
  doc: Y.Doc;
  peers: Map<string, Peer>;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  lastActivityAt: number;
  /**
   * The last writer who changed the doc. A snapshot needs a writer's
   * identity, and the last writer may already have left by the time
   * the debounce fires or the room empties.
   */
  lastWriter: AuthUser | null;
  /** True when the doc has changes no snapshot has saved yet. */
  dirty: boolean;
}

function roomKey(mapId: string, drawingSetId: string): string {
  return `${mapId}:${drawingSetId}`;
}

@Injectable()
export class DrawingsCollabService {
  private readonly log = new Logger(DrawingsCollabService.name);
  private readonly rooms = new Map<string, CollabRoom>();
  private readonly tickets = new Map<string, CollabTicketRecord>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
    private readonly drawings: DrawingsService,
  ) {}

  /**
   * Mint a collab ticket. Writers must pass assertCanWriteSet;
   * observers need canRead only.
   */
  async mintTicket(
    user: AuthUser,
    mapId: string,
    drawingSetId: string,
  ): Promise<CollabTicketIssue> {
    const set = await this.drawings.requireWritableSet(
      { kind: 'user', user },
      mapId,
      drawingSetId,
    ).catch(async (err) => {
      // Writers get requireWritableSet; observers fall through to
      // canRead + set existence when write ACL fails.
      if (!(err instanceof ForbiddenException || err instanceof NotFoundException)) {
        throw err;
      }
      return null;
    });

    let role: CollabRole = 'writer';
    if (!set) {
      await this.assertCanRead(user, mapId);
      const listed = await this.drawings.list(user, mapId);
      if (!listed.some((s) => s.id === drawingSetId)) {
        throw new NotFoundException('Drawing set not found');
      }
      role = 'observer';
    }

    this.pruneTickets();
    const connectionId = mintConnectionId(user.id);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, {
      user,
      mapId,
      drawingSetId,
      role,
      connectionId,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return {
      ticket,
      connectionId,
      role,
      expiresInMs: TICKET_TTL_MS,
      wsPath:
        `/api/realtime/drawings-ws?mapId=${encodeURIComponent(mapId)}` +
        `&drawingSetId=${encodeURIComponent(drawingSetId)}` +
        `&ticket=${encodeURIComponent(ticket)}`,
    };
  }

  consumeTicket(
    ticket: string,
    mapId: string,
    drawingSetId: string,
  ): CollabTicketRecord {
    this.pruneTickets();
    const rec = this.tickets.get(ticket);
    if (!rec) throw new UnauthorizedException('Invalid or expired ticket');
    if (rec.mapId !== mapId || rec.drawingSetId !== drawingSetId) {
      throw new UnauthorizedException('Ticket map/set mismatch');
    }
    this.tickets.delete(ticket);
    return rec;
  }

  async join(
    rec: CollabTicketRecord,
    send: (msg: unknown) => void,
  ): Promise<{ connectionId: string; role: CollabRole }> {
    const key = roomKey(rec.mapId, rec.drawingSetId);
    let room = this.rooms.get(key);
    if (!room) {
      room = await this.bootstrapRoom(rec.mapId, rec.drawingSetId, rec.user);
      this.rooms.set(key, room);
    }
    room.lastActivityAt = Date.now();
    room.peers.set(rec.connectionId, {
      connectionId: rec.connectionId,
      user: rec.user,
      role: rec.role,
      send,
      updateTimestamps: [],
    });
    const update = Y.encodeStateAsUpdate(room.doc);
    send({
      type: 'sync',
      update: Buffer.from(update).toString('base64'),
      role: rec.role,
    });
    return { connectionId: rec.connectionId, role: rec.role };
  }

  applyUpdate(
    mapId: string,
    drawingSetId: string,
    connectionId: string,
    updateB64: string,
  ): void {
    const room = this.rooms.get(roomKey(mapId, drawingSetId));
    if (!room) throw new NotFoundException('Collab room not found');
    const peer = room.peers.get(connectionId);
    if (!peer) throw new UnauthorizedException('Not in room');
    if (peer.role !== 'writer') {
      throw new ForbiddenException('Observers cannot push CRDT updates');
    }
    this.assertUpdateRate(peer);
    let update: Uint8Array;
    try {
      update = Buffer.from(updateB64, 'base64');
    } catch {
      throw new ForbiddenException('Malformed update');
    }
    if (update.byteLength === 0) return;
    Y.applyUpdate(room.doc, update);
    room.lastActivityAt = Date.now();
    room.lastWriter = peer.user;
    room.dirty = true;
    for (const [id, other] of room.peers) {
      if (id === connectionId) continue;
      other.send({ type: 'update', update: updateB64 });
    }
    this.scheduleSnapshot(room);
  }

  leave(mapId: string, drawingSetId: string, connectionId: string): void {
    const key = roomKey(mapId, drawingSetId);
    const room = this.rooms.get(key);
    if (!room) return;
    // Any unsaved change was made by a writer recorded in lastWriter,
    // so the final snapshot below can still save it after that writer
    // is gone.
    room.peers.delete(connectionId);
    room.lastActivityAt = Date.now();
    if (room.peers.size === 0) {
      if (room.snapshotTimer) {
        clearTimeout(room.snapshotTimer);
        room.snapshotTimer = null;
      }
      void this.snapshotNow(room).finally(() => {
        if (room.peers.size === 0) {
          room.doc.destroy();
          this.rooms.delete(key);
        }
      });
    } else {
      this.scheduleSnapshot(room);
    }
    this.pruneIdleRooms();
  }

  /** Test helper: feature count currently in a room doc. */
  debugFeatureCount(mapId: string, drawingSetId: string): number {
    const room = this.rooms.get(roomKey(mapId, drawingSetId));
    if (!room) return 0;
    return room.doc.getMap('features').size;
  }

  private async bootstrapRoom(
    mapId: string,
    drawingSetId: string,
    user: AuthUser,
  ): Promise<CollabRoom> {
    const sets = await this.drawings.list(user, mapId);
    const set = sets.find((s) => s.id === drawingSetId);
    if (!set) throw new NotFoundException('Drawing set not found');
    const doc = new Y.Doc();
    const features = doc.getMap<string>('features');
    doc.transact(() => {
      for (const f of set.features) {
        features.set(f.id, JSON.stringify(f));
      }
    });
    return {
      mapId,
      drawingSetId,
      doc,
      peers: new Map(),
      snapshotTimer: null,
      lastActivityAt: Date.now(),
      lastWriter: null,
      dirty: false,
    };
  }

  private scheduleSnapshot(room: CollabRoom): void {
    if (room.snapshotTimer) clearTimeout(room.snapshotTimer);
    const timer = setTimeout(() => {
      room.snapshotTimer = null;
      void this.snapshotNow(room);
    }, SNAPSHOT_DEBOUNCE_MS);
    // Don't keep the process alive for debounce alone (tests / idle).
    timer.unref?.();
    room.snapshotTimer = timer;
  }

  private async snapshotNow(room: CollabRoom): Promise<void> {
    if (!room.dirty) return;
    try {
      const features = featuresFromDoc(room.doc);
      // Save as a writer still in the room, else as the last writer
      // to change the doc, who may have left already. Never as an
      // observer: drawings.update would refuse it and the last edits
      // would be lost when the room closes.
      const user =
        [...room.peers.values()].find((p) => p.role === 'writer')?.user ??
        room.lastWriter;
      if (!user) return;
      room.dirty = false;
      try {
        await this.drawings.update(
          { kind: 'user', user },
          room.mapId,
          room.drawingSetId,
          { features },
        );
      } catch (err) {
        room.dirty = true;
        throw err;
      }
    } catch (err) {
      this.log.warn(
        `drawings collab snapshot failed map=${room.mapId} set=${room.drawingSetId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private assertUpdateRate(peer: Peer): void {
    const now = Date.now();
    peer.updateTimestamps = peer.updateTimestamps.filter((t) => now - t < 1000);
    if (peer.updateTimestamps.length >= DRAWINGS_WS_MAX_UPDATES_PER_SEC) {
      throw new ForbiddenException('Update rate exceeded');
    }
    peer.updateTimestamps.push(now);
  }

  private async assertCanRead(user: AuthUser, mapId: string): Promise<void> {
    const item = await this.prisma.item.findFirst({
      where: { id: mapId, deletedAt: null, type: 'map' },
    });
    if (!item) throw new NotFoundException('Map not found');
    const shares = await this.prisma.itemShare.findMany({
      where: { itemId: mapId },
    });
    if (!this.sharing.canRead(user, item, shares)) {
      throw new NotFoundException('Map not found');
    }
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [k, v] of this.tickets) {
      if (v.expiresAt <= now) this.tickets.delete(k);
    }
  }

  private pruneIdleRooms(): void {
    const now = Date.now();
    for (const [key, room] of this.rooms) {
      if (room.peers.size > 0) continue;
      if (now - room.lastActivityAt > ROOM_IDLE_MS) {
        if (room.snapshotTimer) clearTimeout(room.snapshotTimer);
        room.doc.destroy();
        this.rooms.delete(key);
      }
    }
  }
}

function featuresFromDoc(doc: Y.Doc): DrawingFeature[] {
  const map = doc.getMap<string>('features');
  const out: DrawingFeature[] = [];
  map.forEach((raw) => {
    try {
      const parsed = JSON.parse(raw) as DrawingFeature;
      if (parsed && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      /* skip corrupt */
    }
  });
  return out;
}

function mintConnectionId(userId: string): string {
  return `${userId.slice(0, 8)}-${randomBytes(6).toString('hex')}`;
}
