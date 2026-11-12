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
/**
 * How often every peer's access is checked again. Access is decided
 * at ticket mint; without a re-check a writer whose share was removed
 * kept reading and writing for as long as the tab stayed open.
 */
export const COLLAB_REAUTH_MS = 15_000;
/**
 * Encoded size one room's doc may reach. The REST path caps a set at
 * 1 MB of JSON; the CRDT carries some overhead on top. Without a cap
 * any writer could grow the in-memory doc until the API ran out of
 * memory.
 */
export const COLLAB_MAX_DOC_BYTES = 2 * 1024 * 1024;
/** Connections one room accepts. */
export const COLLAB_MAX_PEERS = 50;

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
  /** Closes the peer's socket. Absent in unit tests. */
  close?: () => void;
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
  /** Upper bound on the encoded doc size; recomputed when near the cap. */
  approxBytes: number;
  reauthTimer: ReturnType<typeof setInterval> | null;
}

function roomKey(mapId: string, drawingSetId: string): string {
  return `${mapId}:${drawingSetId}`;
}

@Injectable()
export class DrawingsCollabService {
  private readonly log = new Logger(DrawingsCollabService.name);
  private readonly rooms = new Map<string, CollabRoom>();
  private readonly tickets = new Map<string, CollabTicketRecord>();
  /**
   * Rooms being loaded. Two first joiners used to load two rooms and
   * the second overwrote the first, leaving the first client in a room
   * nobody else could reach. Both now wait on one load.
   */
  private readonly booting = new Map<string, Promise<CollabRoom>>();

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
    close?: () => void,
  ): Promise<{ connectionId: string; role: CollabRole }> {
    const key = roomKey(rec.mapId, rec.drawingSetId);
    let room = this.rooms.get(key);
    if (!room) {
      let pending = this.booting.get(key);
      if (!pending) {
        pending = this.bootstrapRoom(rec.mapId, rec.drawingSetId, rec.user).finally(
          () => this.booting.delete(key),
        );
        this.booting.set(key, pending);
      }
      const booted = await pending;
      room = this.rooms.get(key);
      if (!room) {
        room = booted;
        this.rooms.set(key, room);
        this.startReauth(room);
      }
    }
    if (room.peers.size >= COLLAB_MAX_PEERS) {
      throw new ForbiddenException('This markup room is full.');
    }
    room.lastActivityAt = Date.now();
    room.peers.set(rec.connectionId, {
      connectionId: rec.connectionId,
      user: rec.user,
      role: rec.role,
      send,
      ...(close ? { close } : {}),
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
    if (room.approxBytes + update.byteLength > COLLAB_MAX_DOC_BYTES) {
      // The running total only grows, so measure the real doc before
      // refusing: overwrites and deletes may have shrunk it.
      room.approxBytes = Y.encodeStateAsUpdate(room.doc).byteLength;
      if (room.approxBytes + update.byteLength > COLLAB_MAX_DOC_BYTES) {
        throw new ForbiddenException(
          'This markup set is too large. Split it into smaller sets or simplify the shapes.',
        );
      }
    }
    Y.applyUpdate(room.doc, update);
    room.approxBytes += update.byteLength;
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
        if (room.peers.size === 0 && this.rooms.get(key) === room) {
          this.destroyRoom(key, room);
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
      approxBytes: Y.encodeStateAsUpdate(doc).byteLength,
      reauthTimer: null,
    };
  }

  private destroyRoom(key: string, room: CollabRoom): void {
    if (room.snapshotTimer) clearTimeout(room.snapshotTimer);
    if (room.reauthTimer) clearInterval(room.reauthTimer);
    room.doc.destroy();
    this.rooms.delete(key);
  }

  private startReauth(room: CollabRoom): void {
    const timer = setInterval(() => {
      void this.reauthorize(room);
    }, COLLAB_REAUTH_MS);
    timer.unref?.();
    room.reauthTimer = timer;
  }

  /**
   * Check every peer's access again, the same checks the ticket mint
   * made, and drop the ones that no longer pass. Public for tests.
   */
  async reauthorize(room: CollabRoom | { mapId: string; drawingSetId: string }): Promise<void> {
    const live = this.rooms.get(roomKey(room.mapId, room.drawingSetId));
    if (!live) return;
    for (const peer of [...live.peers.values()]) {
      if (await this.stillAllowed(peer.user, live, peer.role)) continue;
      peer.send({ type: 'error', message: 'Your access to this markup has changed.' });
      peer.close?.();
      this.leave(live.mapId, live.drawingSetId, peer.connectionId);
    }
  }

  private async stillAllowed(
    user: AuthUser,
    room: CollabRoom,
    role: CollabRole,
  ): Promise<boolean> {
    try {
      if (role === 'writer') {
        await this.drawings.requireWritableSet(
          { kind: 'user', user },
          room.mapId,
          room.drawingSetId,
        );
      } else {
        await this.assertCanRead(user, room.mapId);
      }
      return true;
    } catch (err) {
      // Only a definite refusal drops a peer; a database blip should
      // not disconnect everyone.
      return !(err instanceof ForbiddenException || err instanceof NotFoundException);
    }
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
    const features = featuresFromDoc(room.doc);
    // Save as a writer still in the room, else as the last writer to
    // change the doc, who may have left already. Never as an observer:
    // drawings.update would refuse it. Try each in turn, so one writer
    // whose access was removed cannot make every save fail.
    const candidates: AuthUser[] = [];
    for (const p of room.peers.values()) {
      if (p.role === 'writer' && !candidates.some((u) => u.id === p.user.id)) {
        candidates.push(p.user);
      }
    }
    if (room.lastWriter && !candidates.some((u) => u.id === room.lastWriter!.id)) {
      candidates.push(room.lastWriter);
    }
    if (candidates.length === 0) return;
    room.dirty = false;
    let lastErr: unknown = null;
    for (const user of candidates) {
      try {
        await this.drawings.update(
          { kind: 'user', user },
          room.mapId,
          room.drawingSetId,
          { features },
        );
        return;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof ForbiddenException || err instanceof NotFoundException)) break;
      }
    }
    room.dirty = true;
    this.log.warn(
      `drawings collab snapshot failed map=${room.mapId} set=${room.drawingSetId}: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
    // Tell the people in the room, rather than only the server log.
    for (const p of room.peers.values()) {
      p.send({ type: 'error', message: 'Markup changes could not be saved.' });
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
        this.destroyRoom(key, room);
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
