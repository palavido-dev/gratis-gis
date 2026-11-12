// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

import {
  DRAWINGS_WS_MAX_PAYLOAD_BYTES,
  isDrawingsFrameWithinBudget,
} from './drawings-collab-frame.js';
import { DrawingsCollabService } from './drawings-collab.service.js';

interface SocketState {
  mapId: string;
  drawingSetId: string;
  connectionId: string;
}

/**
 * Drawings CRDT WebSocket (R1-presence-crdt).
 *
 * Clients mint a ticket over HTTP, then open
 * `wss://…/api/realtime/drawings-ws?mapId=&drawingSetId=&ticket=`.
 * Wire protocol (JSON text frames, base64 Yjs updates):
 *   server -> client: { type: 'sync', update, role }
 *                     { type: 'update', update }
 *                     { type: 'error', message }
 *   client -> server: { type: 'update', update }
 *                     { type: 'leave' }
 */
@WebSocketGateway({
  path: '/api/realtime/drawings-ws',
  maxPayload: DRAWINGS_WS_MAX_PAYLOAD_BYTES,
})
export class DrawingsCollabGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly log = new Logger(DrawingsCollabGateway.name);
  private readonly state = new WeakMap<WebSocket, SocketState>();

  constructor(private readonly collab: DrawingsCollabService) {}

  async handleConnection(client: WebSocket, ...args: unknown[]): Promise<void> {
    const req = args[0] as IncomingMessage | undefined;
    const url = new URL(req?.url ?? '/', 'http://localhost');
    const mapId = url.searchParams.get('mapId') ?? '';
    const drawingSetId = url.searchParams.get('drawingSetId') ?? '';
    const ticket = url.searchParams.get('ticket') ?? '';
    if (!mapId || !drawingSetId || !ticket) {
      this.close(client, 'Missing mapId, drawingSetId, or ticket');
      return;
    }
    let rec;
    try {
      rec = this.collab.consumeTicket(ticket, mapId, drawingSetId);
    } catch (err) {
      this.close(client, err instanceof Error ? err.message : 'Unauthorized');
      return;
    }

    client.on('message', (raw) => {
      void this.onMessage(client, raw);
    });

    try {
      const joined = await this.collab.join(
        rec,
        (msg) => this.send(client, msg),
        () => {
          try {
            client.close();
          } catch {
            /* ignore */
          }
        },
      );
      this.state.set(client, {
        mapId,
        drawingSetId,
        connectionId: joined.connectionId,
      });
      // The socket may have closed while the room was loading. Its
      // disconnect then found no state and did nothing, which left a
      // ghost peer that kept the room alive forever.
      if (client.readyState !== client.OPEN) {
        this.handleDisconnect(client);
      }
    } catch (err) {
      this.close(client, err instanceof Error ? err.message : 'Join failed');
    }
  }

  handleDisconnect(client: WebSocket): void {
    const st = this.state.get(client);
    if (!st) return;
    this.collab.leave(st.mapId, st.drawingSetId, st.connectionId);
    this.state.delete(client);
  }

  private async onMessage(client: WebSocket, raw: unknown): Promise<void> {
    const st = this.state.get(client);
    if (!st) return;
    if (!isDrawingsFrameWithinBudget(raw)) {
      this.close(client, 'Frame too large');
      return;
    }
    let msg: { type?: string; update?: string };
    try {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : String(raw);
      msg = JSON.parse(text) as { type?: string; update?: string };
    } catch {
      this.send(client, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    try {
      if (msg.type === 'leave') {
        this.collab.leave(st.mapId, st.drawingSetId, st.connectionId);
        client.close();
        return;
      }
      if (msg.type === 'update' && typeof msg.update === 'string') {
        this.collab.applyUpdate(
          st.mapId,
          st.drawingSetId,
          st.connectionId,
          msg.update,
        );
        return;
      }
      this.send(client, { type: 'error', message: 'Unknown message type' });
    } catch (err) {
      this.send(client, {
        type: 'error',
        message: err instanceof Error ? err.message : 'Update failed',
      });
    }
  }

  private send(client: WebSocket, msg: unknown): void {
    if (client.readyState !== client.OPEN) return;
    try {
      client.send(JSON.stringify(msg));
    } catch (err) {
      this.log.debug(
        `drawings-ws send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
