import { useEffect, useRef, useState } from "react";
import { RealtimeConnection, type PersistedSession } from "./connection.js";
import { RemoteCursorStore } from "./interpolation.js";
import { CanvasRenderer } from "./render.js";
import { CursorThrottler, cursorRateForRtt, type Point } from "./throttle.js";
import type { ConnectionStatus, Participant, SyncMetrics } from "./types.js";

const SESSION_KEY_PREFIX = "multiplayer-sync.session.";
const EMPTY_METRICS: SyncMetrics = {
  rttMs: null, smoothedRttMs: null, jitterMs: null, txRate: 0, rxRate: 0, staleDrops: 0, reconnects: 0, cursorRateHz: 30, interpolationDelayMs: 100
};

function roomFromLocation(): string {
  const candidate = new URLSearchParams(window.location.search).get("room");
  return candidate && /^[a-zA-Z0-9_-]{1,64}$/.test(candidate) ? candidate : "lobby";
}

function loadSession(roomId: string): PersistedSession | null {
  try {
    // sessionStorage survives refresh in this tab but gives independently opened
    // tabs distinct logical identities for the multi-client demo.
    const raw = window.sessionStorage.getItem(`${SESSION_KEY_PREFIX}${roomId}`);
    if (!raw) return null;
    const candidate = JSON.parse(raw) as Partial<PersistedSession>;
    return typeof candidate.clientId === "string" && typeof candidate.resumeToken === "string" && typeof candidate.seq === "number" && Number.isSafeInteger(candidate.seq)
      ? { clientId: candidate.clientId, resumeToken: candidate.resumeToken, seq: Math.max(0, candidate.seq) }
      : null;
  } catch {
    return null;
  }
}

function websocketEndpoint(): string {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:3001/ws`;
}

function metric(value: number | null, suffix = "ms"): string {
  return value === null ? "—" : `${Math.round(value)}${suffix}`;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const storeRef = useRef(new RemoteCursorStore());
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const throttlerRef = useRef<CursorThrottler | null>(null);
  const localPointRef = useRef<Point | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const [roomId] = useState(roomFromLocation);
  const [status, setStatus] = useState<ConnectionStatus>("CONNECTING");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [metrics, setMetrics] = useState<SyncMetrics>(EMPTY_METRICS);
  const [protocolError, setProtocolError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new CanvasRenderer(canvas);
    rendererRef.current = renderer;

    const connection = new RealtimeConnection({
      endpoint: websocketEndpoint(),
      roomId,
      session: loadSession(roomId),
      onSession(session) {
        try { window.sessionStorage.setItem(`${SESSION_KEY_PREFIX}${roomId}`, JSON.stringify(session)); } catch { /* storage is optional */ }
      },
      onStatus: setStatus,
      onMetrics(nextMetrics) {
        setMetrics(nextMetrics);
        throttlerRef.current?.setRateHz(cursorRateForRtt(nextMetrics.rttMs));
        storeRef.current.setInterpolationDelay(nextMetrics.interpolationDelayMs);
      },
      onProtocolError: setProtocolError,
      onMessage(message) {
        if (message.type === "welcome") {
          selfIdRef.current = message.clientId;
          storeRef.current.clear();
          setParticipants(message.participants);
          for (const cursor of message.cursors) {
            if (cursor.clientId !== message.clientId) {
              storeRef.current.push(cursor.clientId, { ...cursor, receivedAt: performance.now() });
            }
          }
          return;
        }
        if (message.type === "presence") {
          setParticipants(message.participants);
          const remoteIds = new Set(message.participants.map((participant) => participant.clientId).filter((id) => id !== selfIdRef.current));
          storeRef.current.retain(remoteIds);
          return;
        }
        if (message.type === "cursor" && message.clientId !== selfIdRef.current) {
          const accepted = storeRef.current.push(message.clientId, { ...message, receivedAt: performance.now() });
          if (!accepted) connection.recordStaleDrop();
          return;
        }
        if (message.type === "reaction") {
          renderer.addReaction(message, message.eventId);
        }
      }
    });
    connectionRef.current = connection;
    const throttler = new CursorThrottler((point) => connection.sendCursor(point));
    throttlerRef.current = throttler;
    // Deferring one task lets React Strict Mode discard its development-only
    // rehearsal effect before a real WebSocket handshake begins.
    const connectTimer = window.setTimeout(() => connection.connect(), 0);

    let animationFrame = 0;
    const render = (now: number) => {
      renderer.render(storeRef.current.positionsAt(now), now);
      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(connectTimer);
      throttler.dispose();
      connection.dispose();
      renderer.dispose();
      connectionRef.current = null;
      throttlerRef.current = null;
      rendererRef.current = null;
    };
  }, [roomId]);

  const publishPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = rendererRef.current?.pointFromEvent(event.nativeEvent);
    if (!point) return;
    localPointRef.current = point;
    throttlerRef.current?.push(point);
  };

  const sendReaction = () => {
    const point = localPointRef.current ?? rendererRef.current?.center();
    if (point) connectionRef.current?.sendReaction(point);
  };

  const connected = status === "CONNECTED";
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">REAL-TIME SYNC</p>
          <h1>Multiplayer cursor state</h1>
        </div>
        <div className={`connection ${connected ? "online" : "offline"}`} aria-live="polite">
          <span className="status-dot" /> {status}
        </div>
      </header>

      <section className="meta-row" aria-label="Room information">
        <span><strong>ROOM</strong> {roomId}</span>
        <span><strong>PARTICIPANTS</strong> {participants.length}</span>
        <button type="button" onClick={sendReaction} disabled={!connected} title="Send a synchronized heart reaction">♥ Send reaction</button>
      </section>

      <section className="surface-wrap">
        <canvas
          ref={canvasRef}
          className="sync-surface"
          aria-label="Shared cursor surface"
          onPointerMove={publishPointer}
          onPointerEnter={publishPointer}
        />
        {participants.length <= 1 && <p className="empty-state">Open this URL in another tab to join the room.</p>}
      </section>

      <section className="debug-panel" aria-label="Synchronization telemetry">
        <div><span>RTT</span><strong>{metric(metrics.rttMs)}</strong></div>
        <div><span>Smoothed</span><strong>{metric(metrics.smoothedRttMs)}</strong></div>
        <div><span>Jitter</span><strong>{metric(metrics.jitterMs)}</strong></div>
        <div><span>TX</span><strong>{metrics.txRate}/s</strong></div>
        <div><span>RX</span><strong>{metrics.rxRate}/s</strong></div>
        <div><span>Rate</span><strong>{metrics.cursorRateHz}Hz</strong></div>
        <div><span>Interp</span><strong>{metrics.interpolationDelayMs}ms</strong></div>
        <div><span>Stale drops</span><strong>{metrics.staleDrops}</strong></div>
        <div><span>Reconnects</span><strong>{metrics.reconnects}</strong></div>
      </section>
      {protocolError && <p className="protocol-error" role="status">Protocol notice: {protocolError}</p>}
    </main>
  );
}
