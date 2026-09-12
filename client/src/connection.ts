import {
  parseServerMessage,
  serialize,
  type ClientId,
  type ClientMessage,
  type ServerMessage
} from "./protocol.js";
import { cursorRateForRtt, type Point } from "./throttle.js";
import type { ConnectionStatus, SyncMetrics } from "./types.js";

export interface PersistedSession {
  clientId: ClientId;
  resumeToken: string;
  seq: number;
}

export interface ConnectionOptions {
  endpoint: string;
  roomId: string;
  session: PersistedSession | null;
  onSession(session: PersistedSession): void;
  onStatus(status: ConnectionStatus): void;
  onMessage(message: ServerMessage): void;
  onMetrics(metrics: SyncMetrics): void;
  onProtocolError(message: string): void;
}

type OutboundMessage =
  | { type: "cursor"; x: number; y: number }
  | { type: "reaction"; x: number; y: number; reaction: "heart" }
  | { type: "ping" }
  | { type: "pong"; pingId: string };

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
const METRIC_WINDOW_MS = 1_000;
const METRIC_EMIT_INTERVAL_MS = 250;

const initialMetrics = (): SyncMetrics => ({
  rttMs: null,
  jitterMs: null,
  txRate: 0,
  rxRate: 0,
  staleDrops: 0,
  reconnects: 0,
  cursorRateHz: 30
});

/**
 * Browser transport with explicit state transitions, bounded exponential retry,
 * identity resume, heartbeat response, and low-frequency observability updates.
 */
export class RealtimeConnection {
  private socket: WebSocket | undefined;
  private session: PersistedSession | null;
  private status: ConnectionStatus = "DISCONNECTED";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private latencyTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private welcomed = false;
  private readonly sentAt: number[] = [];
  private readonly receivedAt: number[] = [];
  private readonly rttSamples: number[] = [];
  private metrics = initialMetrics();
  private lastMetricEmitAt = 0;

  constructor(private readonly options: ConnectionOptions) {
    this.session = options.session;
  }

  connect(): void {
    if (this.disposed || this.socket) return;
    this.setStatus(this.session ? "RECONNECTING" : "CONNECTING");
    const url = new URL(this.options.endpoint);
    url.searchParams.set("room", this.options.roomId);
    if (this.session?.resumeToken) url.searchParams.set("resume", this.session.resumeToken);

    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.welcomed = false;
      this.setStatus("SYNCHRONIZING");
    });
    socket.addEventListener("message", (event) => this.handleMessage(socket, event));
    socket.addEventListener("error", () => {
      // Browsers intentionally expose little diagnostic detail. The close event retries.
    });
    socket.addEventListener("close", () => this.handleClose(socket));
  }

  sendCursor(point: Point): boolean {
    return this.send({ type: "cursor", ...point });
  }

  sendReaction(point: Point): boolean {
    return this.send({ type: "reaction", ...point, reaction: "heart" });
  }

  recordStaleDrop(): void {
    this.metrics = { ...this.metrics, staleDrops: this.metrics.staleDrops + 1 };
    this.emitMetrics();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.latencyTimer) clearInterval(this.latencyTimer);
    this.reconnectTimer = undefined;
    this.latencyTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, "Component unmounted");
    }
    this.setStatus("DISCONNECTED");
  }

  private send(message: OutboundMessage): boolean {
    const socket = this.socket;
    if (!this.welcomed || !this.session || !socket || socket.readyState !== WebSocket.OPEN) return false;
    const fullMessage = {
      ...message,
      clientId: this.session.clientId,
      seq: this.nextSequence(),
      timestamp: Date.now()
    } as ClientMessage;
    try {
      socket.send(serialize(fullMessage));
      this.recordOutbound();
      return true;
    } catch {
      return false;
    }
  }

  private nextSequence(): number {
    if (!this.session) throw new Error("Cannot sequence a message before welcome.");
    this.session = { ...this.session, seq: this.session.seq + 1 };
    this.options.onSession(this.session);
    return this.session.seq;
  }

  private handleMessage(socket: WebSocket, event: MessageEvent): void {
    if (socket !== this.socket || typeof event.data !== "string") {
      this.options.onProtocolError("Received unsupported WebSocket frame.");
      return;
    }
    const parsed = parseServerMessage(event.data);
    if (!parsed.ok) {
      this.options.onProtocolError(`${parsed.code}: ${parsed.message}`);
      return;
    }
    this.recordInbound();
    const message = parsed.value;

    if (message.type === "welcome") {
      const priorSeq = this.session?.clientId === message.clientId ? this.session.seq : 0;
      this.session = { clientId: message.clientId, resumeToken: message.resumeToken, seq: priorSeq };
      this.options.onSession(this.session);
      this.welcomed = true;
      this.reconnectAttempt = 0;
      this.setStatus("CONNECTED");
      this.startLatencyProbes();
    } else if (message.type === "ping") {
      this.send({ type: "pong", pingId: message.pingId });
    } else if (message.type === "pong" && message.clientId === this.session?.clientId) {
      this.recordRtt(Math.max(0, Date.now() - message.timestamp));
    } else if (message.type === "error") {
      this.options.onProtocolError(`${message.code}: ${message.message}`);
    }

    this.options.onMessage(message);
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.welcomed = false;
    if (this.latencyTimer) clearInterval(this.latencyTimer);
    this.latencyTimer = undefined;
    if (this.disposed) return;

    this.setStatus("RECONNECTING");
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.metrics = { ...this.metrics, reconnects: this.metrics.reconnects + 1 };
    this.emitMetrics(true);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private startLatencyProbes(): void {
    if (this.latencyTimer) clearInterval(this.latencyTimer);
    const probe = () => this.send({ type: "ping" });
    probe();
    this.latencyTimer = setInterval(probe, 5_000);
  }

  private recordOutbound(): void {
    this.sentAt.push(performance.now());
    this.updateRates();
  }

  private recordInbound(): void {
    this.receivedAt.push(performance.now());
    this.updateRates();
  }

  private recordRtt(rttMs: number): void {
    this.rttSamples.push(rttMs);
    if (this.rttSamples.length > 8) this.rttSamples.shift();
    const previous = this.metrics.rttMs;
    const jitterMs = previous === null ? 0 : Math.abs(rttMs - previous);
    const cursorRateHz = cursorRateForRtt(rttMs);
    this.metrics = { ...this.metrics, rttMs, jitterMs, cursorRateHz };
    this.emitMetrics();
  }

  private updateRates(): void {
    const now = performance.now();
    while (this.sentAt[0] !== undefined && now - this.sentAt[0] > METRIC_WINDOW_MS) this.sentAt.shift();
    while (this.receivedAt[0] !== undefined && now - this.receivedAt[0] > METRIC_WINDOW_MS) this.receivedAt.shift();
    this.metrics = { ...this.metrics, txRate: this.sentAt.length, rxRate: this.receivedAt.length };
    this.emitMetrics();
  }

  private emitMetrics(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastMetricEmitAt < METRIC_EMIT_INTERVAL_MS) return;
    this.lastMetricEmitAt = now;
    this.options.onMetrics(this.metrics);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }
}
