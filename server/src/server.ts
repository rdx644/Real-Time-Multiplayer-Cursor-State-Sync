import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  MAX_PAYLOAD_BYTES,
  isValidRoomId,
  parseClientMessage,
  serialize,
  type ClientId,
  type ServerMessage
} from "./protocol.js";
import { Room, RoomManager, SOCKET_OPEN, SLOW_CONSUMER_BUFFER_BYTES, type ConnectedClient } from "./room.js";

const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_CONNECTION_MS = 30_000;
const RESUME_SESSION_TTL_MS = 60_000;

/** Parsed once at server creation so configuration is explicit and immutable. */
interface ServerConfig {
  readonly heartbeatIntervalMs: number;
  readonly staleConnectionMs: number;
  readonly resumeSessionTtlMs: number;
  readonly allowedOrigins: ReadonlySet<string>;
}

function parseAllowedOrigins(): ReadonlySet<string> {
  const raw = process.env.ALLOWED_ORIGINS?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? intFromEnv("HEARTBEAT_INTERVAL_MS", HEARTBEAT_INTERVAL_MS),
    staleConnectionMs: overrides.staleConnectionMs ?? intFromEnv("STALE_CONNECTION_MS", STALE_CONNECTION_MS),
    resumeSessionTtlMs: overrides.resumeSessionTtlMs ?? intFromEnv("RESUME_SESSION_TTL_MS", RESUME_SESSION_TTL_MS),
    allowedOrigins: overrides.allowedOrigins ?? parseAllowedOrigins()
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Cross-Site WebSocket Hijacking guard. Browsers always send an `Origin` header
 * and carry ambient credentials, so a browser request is rejected unless its
 * origin is explicitly allow-listed or matches the request's own `Host`.
 * Non-browser clients (`curl`, Node `ws`) omit `Origin` and cannot be the vector
 * CSWSH protects against, so they are still allowed.
 */
function isOriginAllowed(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  const host = request.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

interface ResumeSession {
  clientId: ClientId;
  roomId: string;
  resumeToken: string;
  expiresAt: number;
  lastClientSeq: number;
}

interface ConnectionIdentity {
  clientId: ClientId;
  resumeToken: string;
  lastClientSeq: number;
}

export interface RealtimeServer {
  readonly rooms: RoomManager;
  start(port?: number, host?: string): Promise<number>;
  stop(): Promise<void>;
  address(): string;
}

export function createRealtimeServer(configOverrides: Partial<ServerConfig> = {}): RealtimeServer {
  const config = loadConfig(configOverrides);
  const rooms = new RoomManager();
  const sessions = new Map<string, ResumeSession>();
  const startedAt = Date.now();
  const httpServer = createServer((request, response) => healthHandler(request, response, rooms, startedAt));
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // A post-start error (e.g. a socket-level failure) must never crash the process.
  httpServer.on("error", (error) => console.error("[server] http error", error));
  webSocketServer.on("error", (error) => console.error("[server] websocket error", error));

  function pruneSessions(now = Date.now()): void {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  function claimIdentity(roomId: string, resumeToken: string | null): ConnectionIdentity {
    pruneSessions();
    const prior = resumeToken ? sessions.get(resumeToken) : undefined;
    if (prior && prior.roomId === roomId && prior.expiresAt > Date.now()) {
      prior.expiresAt = Date.now() + config.resumeSessionTtlMs;
      return {
        clientId: prior.clientId,
        resumeToken: prior.resumeToken,
        lastClientSeq: prior.lastClientSeq
      };
    }

    const token = randomBytes(32).toString("base64url");
    const identity = { clientId: randomUUID(), resumeToken: token, lastClientSeq: 0 };
    sessions.set(token, { ...identity, roomId, expiresAt: Date.now() + config.resumeSessionTtlMs });
    return identity;
  }

  function preserveSession(identity: ConnectionIdentity, roomId: string, lastClientSeq: number): void {
    sessions.set(identity.resumeToken, {
      ...identity,
      roomId,
      lastClientSeq,
      expiresAt: Date.now() + config.resumeSessionTtlMs
    });
  }

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== SOCKET_OPEN) return;
    if (socket.bufferedAmount > SLOW_CONSUMER_BUFFER_BYTES) {
      try { socket.terminate?.(); } catch { /* close handler owns removal */ }
      return;
    }
    try {
      socket.send(serialize(message));
    } catch {
      // The WebSocket close handler owns removal. No send should bring down the server.
    }
  }

  function sendError(socket: WebSocket, code: string, message: string): void {
    send(socket, { type: "error", code, message });
  }

  function handleMessage(room: Room, client: ConnectedClient, socket: WebSocket, raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (isBinary) {
      sendError(socket, "binary_not_supported", "Only UTF-8 JSON messages are accepted.");
      return;
    }

    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Buffer.from(raw).toString("utf8");
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      sendError(socket, parsed.code, parsed.message);
      return;
    }

    const message = parsed.value;
    if (message.clientId !== client.id) {
      sendError(socket, "identity_mismatch", "clientId does not belong to this connection.");
      return;
    }
    if (message.seq <= client.lastClientSeq) {
      sendError(socket, "stale_sequence", "Message sequence must increase monotonically.");
      return;
    }

    client.lastClientSeq = message.seq;
    client.lastSeenAt = Date.now();
    if (message.type === "cursor") {
      const serverTimestamp = Date.now();
      const cursor = room.updateCursor(client, message, serverTimestamp);
      room.broadcast({ type: "cursor", ...cursor, eventId: room.nextEventId() }, client.id);
      return;
    }

    if (message.type === "reaction") {
      room.broadcast({
        ...message,
        eventId: room.nextEventId(),
        serverTimestamp: Date.now()
      });
      return;
    }

    if (message.type === "ping") {
      send(socket, { type: "pong", clientId: client.id, seq: message.seq, timestamp: message.timestamp });
      return;
    }

    if (message.type === "pong" && message.pingId === client.pendingHeartbeatId) {
      delete client.pendingHeartbeatId;
    }
  }

  function attachConnection(socket: WebSocket, roomId: string, resumeToken: string | null): void {
    const identity = claimIdentity(roomId, resumeToken);
    const room = rooms.getOrCreate(roomId);
    const now = Date.now();
    const client: ConnectedClient = {
      id: identity.clientId,
      socket,
      joinedAt: now,
      lastSeenAt: now,
      lastClientSeq: identity.lastClientSeq
    };
    const replaced = room.add(client);
    if (replaced && replaced.socket !== socket) {
      try { replaced.socket.close?.(4000, "Replaced by resumed connection"); } catch { /* noop */ }
    }
    preserveSession(identity, roomId, client.lastClientSeq);

    send(socket, {
      type: "welcome",
      clientId: client.id,
      roomId,
      resumeToken: identity.resumeToken,
      participants: room.participants(),
      cursors: room.cursorSnapshot(),
      serverTimestamp: now
    });
    room.broadcastPresence();

    socket.on("message", (raw, isBinary) => handleMessage(room, client, socket, raw, isBinary));
    socket.on("close", () => {
      preserveSession(identity, roomId, client.lastClientSeq);
      if (room.remove(client.id, socket)) {
        room.broadcastPresence();
        rooms.deleteIfEmpty(room);
      }
    });
    socket.on("error", () => {
      // `close` performs the one canonical cleanup path.
    });
  }

  httpServer.on("upgrade", (request, socket, head) => {
    if (!isOriginAllowed(request, config.allowedOrigins)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const roomId = url.searchParams.get("room") ?? "lobby";
    if (url.pathname !== "/ws" || !isValidRoomId(roomId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const resumeToken = url.searchParams.get("resume");
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      attachConnection(webSocket, roomId, resumeToken);
    });
  });

  function heartbeat(): void {
    const now = Date.now();
    pruneSessions(now);
    for (const room of rooms.all()) {
      for (const client of room.clients.values()) {
        if (now - client.lastSeenAt > config.staleConnectionMs) {
          try { client.socket.terminate?.(); } catch { /* close will clean up when possible */ }
          continue;
        }
        const pingId = randomUUID();
        client.pendingHeartbeatId = pingId;
        if (client.socket.readyState === SOCKET_OPEN) {
          try { client.socket.send(serialize({ type: "ping", pingId, timestamp: now })); } catch { /* lifecycle owns cleanup */ }
        }
      }
    }
  }

  return {
    rooms,
    start(port = Number(process.env.PORT ?? 3001), host = process.env.HOST ?? "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          heartbeatTimer = setInterval(heartbeat, config.heartbeatIntervalMs);
          heartbeatTimer.unref?.();
          const address = httpServer.address();
          resolve(typeof address === "object" && address ? address.port : port);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, host);
      });
    },
    async stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const room of rooms.all()) {
        for (const client of room.clients.values()) {
          try { client.socket.terminate?.(); } catch { /* best effort shutdown */ }
        }
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      if (!httpServer.listening) return;
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    },
    address() {
      const address = httpServer.address();
      return typeof address === "object" && address ? `ws://127.0.0.1:${address.port}/ws` : "";
    }
  };
}

function healthHandler(
  _request: IncomingMessage,
  response: import("node:http").ServerResponse,
  rooms: RoomManager,
  startedAt: number
): void {
  let roomCount = 0;
  let clientCount = 0;
  for (const room of rooms.all()) {
    roomCount += 1;
    clientCount += room.size;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "same-origin"
  });
  response.end(JSON.stringify({ ok: true, rooms: roomCount, clients: clientCount, uptimeMs: Date.now() - startedAt }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const realtimeServer = createRealtimeServer();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] received ${signal}, shutting down gracefully`);
    realtimeServer.stop()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("[server] shutdown failed", error);
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  realtimeServer.start().then((port) => {
    console.log(`Real-time server listening on ws://127.0.0.1:${port}/ws`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
