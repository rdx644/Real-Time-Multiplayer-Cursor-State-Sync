import type {
  ClientId,
  CursorMessage,
  CursorState,
  Participant,
  ServerMessage
} from "./protocol.js";
import { serialize } from "./protocol.js";

/** Minimal transport surface used by the room; it keeps room logic testable. */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close?(code?: number, data?: string): void;
  terminate?(): void;
}

export const SOCKET_OPEN = 1;

/**
 * A client whose outgoing buffer exceeds this threshold cannot keep up with the
 * broadcast rate. Terminating it bounds memory and prevents one slow peer from
 * stalling the whole room.
 */
export const SLOW_CONSUMER_BUFFER_BYTES = 1024 * 1024;

export interface ConnectedClient {
  id: ClientId;
  socket: SocketLike;
  joinedAt: number;
  lastSeenAt: number;
  lastClientSeq: number;
  latestCursor?: CursorState;
  pendingHeartbeatId?: string;
}

export class Room {
  readonly clients = new Map<ClientId, ConnectedClient>();
  private eventId = 0;

  constructor(readonly roomId: string) {}

  get size(): number {
    return this.clients.size;
  }

  get(clientId: ClientId): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  /** Replaces a prior socket atomically; delayed close events cannot remove its replacement. */
  add(client: ConnectedClient): ConnectedClient | undefined {
    const previous = this.clients.get(client.id);
    this.clients.set(client.id, client);
    return previous;
  }

  remove(clientId: ClientId, socket: SocketLike): boolean {
    const current = this.clients.get(clientId);
    if (!current || current.socket !== socket) return false;
    this.clients.delete(clientId);
    return true;
  }

  participants(): Participant[] {
    return [...this.clients.values()]
      .map(({ id, joinedAt }) => ({ clientId: id, joinedAt }))
      .sort((a, b) => a.joinedAt - b.joinedAt || a.clientId.localeCompare(b.clientId));
  }

  cursorSnapshot(): CursorState[] {
    return [...this.clients.values()]
      .flatMap((client) => client.latestCursor ? [client.latestCursor] : [])
      .sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  nextEventId(): number {
    this.eventId += 1;
    return this.eventId;
  }

  updateCursor(client: ConnectedClient, message: CursorMessage, serverTimestamp: number): CursorState {
    const cursor: CursorState = {
      clientId: client.id,
      x: message.x,
      y: message.y,
      seq: message.seq,
      timestamp: message.timestamp,
      serverTimestamp
    };
    client.latestCursor = cursor;
    return cursor;
  }

  broadcast(message: ServerMessage, exceptClientId?: ClientId): void {
    const payload = serialize(message);
    for (const client of this.clients.values()) {
      if (client.id === exceptClientId || client.socket.readyState !== SOCKET_OPEN) continue;
      if ((client.socket.bufferedAmount ?? 0) > SLOW_CONSUMER_BUFFER_BYTES) {
        // A slow consumer would let the buffer grow without bound. Dropping the
        // peer is more deterministic than silently losing messages; `close`/`error`
        // performs the canonical membership cleanup.
        try { client.socket.terminate?.(); } catch { /* lifecycle cleans up */ }
        continue;
      }
      try {
        client.socket.send(payload);
      } catch {
        // A close can race with readyState. The lifecycle handler performs cleanup.
      }
    }
  }

  broadcastPresence(): void {
    this.broadcast({ type: "presence", participants: this.participants() });
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  getOrCreate(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  deleteIfEmpty(room: Room): void {
    if (room.size === 0 && this.rooms.get(room.roomId) === room) {
      this.rooms.delete(room.roomId);
    }
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  all(): Iterable<Room> {
    return this.rooms.values();
  }
}
