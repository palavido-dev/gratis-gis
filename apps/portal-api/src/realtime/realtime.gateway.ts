// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  RealtimeService,
  type PresenceMember,
} from './realtime.service.js';

interface SocketState {
  mapId: string;
  user: AuthUser;
  connectionId: string;
  unsubscribe: () => void;
}

/**
 * Presence Phase 1.5 WebSocket transport (#156).
 *
 * Clients mint a short-lived ticket over the authenticated HTTP BFF,
 * then open `wss://<host>/api/realtime/ws?mapId=&ticket=` directly
 * against portal-api (Caddy already upgrades /api/*). JWT never
 * appears on the WS URL.
 *
 * Wire protocol (JSON text frames):
 *   client -> server: { type: 'cursor', cursor: {lng,lat}|null }
 *                     { type: 'heartbeat' }
 *                     { type: 'leave' }
 *   server -> client: { type: 'roster', members: PresenceMember[] }
 *                     { type: 'error', message: string }
 */
@WebSocketGateway({ path: '/api/realtime/ws' })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly state = new WeakMap<WebSocket, SocketState>();

  constructor(private readonly realtime: RealtimeService) {}

  async handleConnection(client: WebSocket, ...args: unknown[]): Promise<void> {
    const req = args[0] as IncomingMessage | undefined;
    const url = new URL(req?.url ?? '/', 'http://localhost');
    const mapId = url.searchParams.get('mapId') ?? '';
    const ticket = url.searchParams.get('ticket') ?? '';
    if (!mapId || !ticket) {
      this.close(client, 'Missing mapId or ticket');
      return;
    }
    let user: AuthUser;
    let connectionId: string;
    try {
      const consumed = this.realtime.consumeTicket(ticket, mapId);
      user = consumed.user;
      connectionId = consumed.connectionId;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      this.close(client, message);
      return;
    }

    const unsubscribe = this.realtime.subscribe(mapId, (members) => {
      this.send(client, { type: 'roster', members });
    });
    this.state.set(client, { mapId, user, connectionId, unsubscribe });

    client.on('message', (raw) => {
      void this.onMessage(client, raw);
    });

    try {
      const roster = await this.realtime.heartbeat(user, mapId, {
        connectionId,
      });
      this.send(client, { type: 'roster', members: roster.members });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Join failed';
      this.close(client, message);
    }
  }

  handleDisconnect(client: WebSocket): void {
    const st = this.state.get(client);
    if (!st) return;
    st.unsubscribe();
    void this.realtime
      .leave(st.user, st.mapId, st.connectionId)
      .catch((err) => {
        this.log.warn(
          `leave on disconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    this.state.delete(client);
  }

  private async onMessage(client: WebSocket, raw: unknown): Promise<void> {
    const st = this.state.get(client);
    if (!st) return;
    let msg: { type?: string; cursor?: { lng: number; lat: number } | null };
    try {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString('utf8')
              : '';
      msg = JSON.parse(text) as typeof msg;
    } catch {
      this.send(client, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    try {
      if (msg.type === 'leave') {
        await this.realtime.leave(st.user, st.mapId, st.connectionId);
        st.unsubscribe();
        this.state.delete(client);
        try {
          client.close();
        } catch {
          /* already closed */
        }
        return;
      }
      if (msg.type === 'cursor' || msg.type === 'heartbeat') {
        const input: {
          connectionId: string;
          cursor?: { lng: number; lat: number } | null;
        } = { connectionId: st.connectionId };
        if (msg.type === 'cursor') {
          input.cursor = msg.cursor ?? null;
        }
        const roster = await this.realtime.heartbeat(
          st.user,
          st.mapId,
          input,
        );
        // heartbeat already notifies subscribers; still ack the sender
        // in case they are the only member (subscribe fire is enough).
        void roster;
        return;
      }
      this.send(client, { type: 'error', message: `Unknown type: ${msg.type}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      this.send(client, { type: 'error', message });
    }
  }

  private send(
    client: WebSocket,
    payload:
      | { type: 'roster'; members: PresenceMember[] }
      | { type: 'error'; message: string },
  ): void {
    if (client.readyState !== 1 /* WebSocket.OPEN */) return;
    try {
      client.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  private close(client: WebSocket, message: string): void {
    this.send(client, { type: 'error', message });
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
}
