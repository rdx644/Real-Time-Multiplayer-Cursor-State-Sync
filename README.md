# Real-Time Multiplayer Cursor / State Sync

A deliberately small, raw-WebSocket shared cursor application for 3–10 people in one room. It demonstrates an explicit synchronization protocol rather than relying on Socket.IO, CRDTs, or a hosted real-time provider.

## Features

- Shared rooms selected with `?room=your-room`.
- Connection-bound logical identities, short-lived resume tokens, and one active presence per logical client.
- Live remote cursors, a synchronized heart reaction, late-join snapshots, and visible participant count.
- Latest-value cursor throttling (15–30 Hz adaptive rate), bounded remote sample buffers, 100 ms interpolation delay, and bounded 120 ms extrapolation.
- Runtime validation on both network boundaries; malformed, oversized, unknown, spoofed, non-finite, and stale messages are rejected safely.
- Server heartbeat, stale-socket termination, deterministic room cleanup, reconnect backoff, RTT/jitter/TX/RX telemetry, and server event IDs for canonical reaction ordering.
- Production hardening: `Origin` allow-listing to prevent cross-site WebSocket hijacking, slow-consumer backpressure, graceful shutdown, secure health/error handling, and environment-driven configuration.

## Architecture

```text
Pointer input → latest-value throttler → typed protocol → native WebSocket
                                                        ↓
Canvas ← interpolation buffer ← validated server events ← room manager
```

React owns low-frequency UI state (presence, connection state, telemetry). A canvas `requestAnimationFrame` loop owns high-frequency cursor and reaction drawing. Transport, protocol, room state, interpolation, and rendering are separate modules.

## Run locally

Prerequisites: Node.js 20+ and npm 10+.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/?room=demo` in 3–5 tabs. Move over the surface in each tab and use **Send reaction**. Use the same room name to share a room; a different valid `room` value creates isolation.

The client expects `ws://localhost:3001/ws` by default. Configure a hosted endpoint with `VITE_WS_URL=wss://example.com/ws`. Persistent WebSockets require a host that supports long-lived upgraded connections; this project intentionally does not include deployment infrastructure.

## Verification

```bash
npm run check   # strict TypeScript (noUnusedLocals, exactOptionalPropertyTypes, ...)
npm run lint    # ESLint (typescript-eslint + react-hooks)
npm test        # vitest unit + integration suite
npm run build   # production client build
npm run verify  # all of the above
```

The tests cover protocol boundary rejection, room fan-out/cleanup rules, stale sequence filtering, bounded interpolation/extrapolation, adaptive throttling, end-to-end cursor/reaction synchronization, identity spoofing rejection, slow-consumer termination, origin rejection, late presence cleanup, and reconnect identity/sequence continuity.

## Configuration

The server reads optional environment variables; sane defaults apply otherwise.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Listening port |
| `HOST` | `127.0.0.1` | Bind address |
| `ALLOWED_ORIGINS` | *(same-origin only)* | Comma-separated extra browser origins permitted on the WebSocket upgrade |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Server heartbeat cadence |
| `STALE_CONNECTION_MS` | `30000` | Idle threshold before terminating a socket |
| `RESUME_SESSION_TTL_MS` | `60000` | How long a resume token survives a disconnect |

`GET /` serves a JSON health check (`{ ok, rooms, clients, uptimeMs }`) for load balancer / orchestration probes.

## Protocol

Every client-originated message carries `{ clientId, seq, timestamp }`. The server checks the `clientId` against the identity assigned to that WebSocket connection and requires strictly increasing sequence numbers.

| Direction | Message | Purpose |
| --- | --- | --- |
| client → server | `cursor` | `{ x, y }` ephemeral latest state |
| client → server | `reaction` | One `heart` discrete action |
| client → server | `ping`, `pong` | RTT probe and heartbeat reply |
| server → client | `welcome` | Assigned identity, resume token, participants, latest cursor snapshot |
| server → client | `presence` | Full current participant list |
| server → client | `cursor`, `reaction` | Validated room events; reactions include canonical `eventId` |
| server → client | `ping`, `pong`, `error` | Liveness, RTT response, explicit safe rejection |

Payloads are capped at 8 KiB. Coordinates are finite and bounded to ±100,000. Message parsing rejects invalid JSON, non-object payloads, missing or wrong primitives, unsupported reactions, oversized fields, stale sequences, and unknown types. See [ARCHITECTURE.md](ARCHITECTURE.md) for exact guarantees.

## Why throttling and interpolation

Pointer events can occur at 60–120+ Hz. Sending all events wastes bandwidth and work, so `CursorThrottler` sends the newest point when its 15–30 Hz slot opens; it never builds a backlog of stale points. The adaptive policy uses local RTT: `<50 ms → 30 Hz`, `<100 → 25 Hz`, `<200 → 20 Hz`, otherwise `15 Hz`.

Network arrival timing is irregular, so remote updates populate a sequence-filtered buffer. The canvas renders about 100 ms behind its local clock and interpolates between adjacent samples. It can project recent velocity for at most 120 ms, then holds the last trusted point. The delay trades a small amount of visual latency for substantially smoother movement.

## Disconnect / reconnect

The server sends heartbeats every 10 seconds and terminates connections with no accepted activity for 30 seconds. `close` removes that exact socket, its cursor state, and broadcasts new presence. The client retries with bounded exponential backoff (500 ms → 10 s) without a reload. A random resume token is held in per-tab session storage and for 60 seconds on the server, so it restores the same logical ID on reconnect/refresh without causing independently opened tabs to share one presence. It also carries the last accepted sequence so reconnect cannot regress ordering.

## Guarantees and limits

- The single server process provides room-local, arrival-order event IDs and latest cursor state while it remains running.
- Cursor history is intentionally ephemeral: only the latest cursor per connected client is retained. A joining client receives a snapshot, not a replay.
- The implementation is designed for a small single-process room, not durable storage, authentication, or horizontal scaling. A server restart loses rooms and resume sessions.
- Resume tokens prevent casual identity collision but are not user authentication; production systems need authenticated, expiring session credentials and TLS (`wss`).

## Manual release gate

1. Open 3–5 tabs in the same room and move all pointers.
2. Join a tab mid-session and confirm current cursors/presence appear.
3. Send simultaneous reactions and observe one canonical server event order.
4. Close a tab; its presence and cursor should disappear.
5. Use browser DevTools offline mode briefly; confirm automatic reconnect and no duplicate cursor.
6. Use network throttling and inspect the telemetry panel for rate, RTT, jitter, and stale-drop behavior.
7. Confirm browser/server consoles show no uncaught errors.

## Requirement traceability

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Raw WebSocket and room state | `server/src/server.ts`, `room.ts` | Integration tests + multi-tab demo |
| Runtime validation / identity | `shared/src/protocol.ts`, server message path | Protocol + integration rejection tests |
| Ordering / bounded cursor state | `room.ts`, `interpolation.ts` | Unit + reconnect tests |
| Throttle / smooth rendering | `throttle.ts`, `App.tsx`, `render.ts` | Unit tests + telemetry |
| Presence / late join / cleanup | `server.ts`, `App.tsx` | Integration tests |
| Reconnect / heartbeat | `connection.ts`, `server.ts` | Reconnect test + manual gate |
| Scaling discussion / limits | `ARCHITECTURE.md` | Documentation review |

## AI use and time

AI assistance was used to turn the supplied engineering blueprint into this implementation and its documentation. A human reviewer should run the commands and manual release gate above before submitting or deploying. Actual elapsed time should be recorded by the project owner before submission; it is deliberately not fabricated here.
