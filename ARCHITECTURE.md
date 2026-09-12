# Architecture and Engineering Guarantees

## 1. System overview

This is a single Node process with native browser `WebSocket` clients and the `ws` package only for the minimal Node upgrade endpoint. There is no Socket.IO, hosted synchronization service, database, CRDT, or cursor history.

```text
React controls / telemetry              Node HTTP + WebSocket upgrade
Canvas requestAnimationFrame            → validate → connection identity
         ↑                               → room latest state → O(n) fan-out
Interpolation buffers ← validated events              ↓
```

The boundaries are intentional:

- `shared/src/protocol.ts`: types, serialization, runtime validators, input limits.
- `server/src/server.ts`: transport lifecycle, identity/resume, heartbeat, protocol boundary.
- `server/src/room.ts`: room membership, snapshots, latest cursor, safe fan-out.
- `client/src/connection.ts`: browser transport/state machine/retry/telemetry.
- `client/src/throttle.ts`: latest-value rate limiting independent of WebSocket code.
- `client/src/interpolation.ts`: sequence filtering, bounded smoothing, bounded prediction.
- `client/src/render.ts`: canvas-only drawing, no React state and no socket calls.

## 2. Protocol and validation

The protocol uses JSON envelopes. Client messages include a caller-provided `clientId`, positive safe-integer `seq`, and finite timestamp, but the server never trusts identity merely because it appears in a message. The initial HTTP upgrade assigns an ID; all subsequent input must exactly match the ID bound to that WebSocket.

The server validates in this order:

```text
payload byte cap → JSON/object → known shape/type → value range
→ connection identity → strictly increasing client sequence → room mutation → one broadcast
```

Failed inputs get a finite `error` response and never mutate room state. Closed sockets are checked before every server send and any race is contained.

The WebSocket query contains only the room and opaque resume token, never a trusted identity. Resume tokens are 32 random bytes, scoped to a room, and expire after 60 seconds. They preserve a logical client ID and last accepted sequence through a short network interruption; they do not authenticate a human user.

### Origin and cross-site hijacking

WebSocket handshakes carry ambient cookies/dial credentials, so an upgrade that ignores `Origin` is susceptible to Cross-Site WebSocket Hijacking (CSWSH). The upgrade path rejects browser requests whose `Origin` is neither explicitly allow-listed (`ALLOWED_ORIGINS`) nor equal to the request's own `Host`. Requests with no `Origin` header (non-browser clients such as `curl` or Node `ws`) are permitted, since they cannot be the cookie-bearing vector CSWSH targets.

### Backpressure

A peer whose outgoing `bufferedAmount` exceeds 1 MiB is considered a slow consumer. Rather than accumulate unbounded memory or silently drop its messages, the server terminates it; the canonical `close` handler then removes membership and cursor state. This keeps fan-out memory bounded and prevents one stalled client from stalling the room.

## 3. Room lifecycle and snapshots

`Room` owns a `Map<clientId, ConnectedClient>`. Each client has one socket, joined timestamp, last activity, last accepted inbound sequence, optional latest cursor, and pending heartbeat identity. Replacing a resumed socket is atomic, and `remove(clientId, socket)` only removes if that exact socket is still current. This prevents an old delayed `close` event from deleting a new connection.

On entry, `welcome` returns full presence and each current latest cursor. The room retains one cursor state per connected client, not a cursor event history. A join therefore has bounded memory/bandwidth and receives the state useful for an interactive surface.

On clean close, error-driven close, or heartbeat termination, the same close handler removes room membership and cursor state, broadcasts presence, and deletes an empty room. This makes zombie cursors bounded by the 30-second stale timeout in a half-open failure.

## 4. Ordering and reconciliation

Each client’s outbound sequence is persisted alongside its resume token in **per-tab session storage** and preserved server-side within the resume session. Session storage intentionally survives a refresh/reconnect in that tab while independently opened demo tabs receive distinct identities. The server rejects `seq <= lastClientSeq`; receivers also reject a remote cursor sample that does not increase its last seen sequence. This two-sided rule stops delayed cursor packets from visibly moving a remote pointer backwards.

Reactions receive a monotonically increasing room `eventId` at the server. It establishes a deterministic canonical order for simultaneous discrete actions. Cursors use last-writer-by-accepted-sequence because cursor location is ephemeral state, not an append-only action log.

Client timestamps are validated but do not determine authority. The server’s event order is authoritative while that process is alive. Interpolation uses browser arrival time so it does not assume client wall clocks are synchronized.

## 5. Throttling, interpolation, and rendering

The input pipeline retains only the latest pointer position. The `CursorThrottler` emits immediately when permitted, otherwise schedules one send for the current rate slot; a later event replaces the scheduled point. Its rate is bounded to 15–30 Hz and changes from local RTT measurements.

Remote buffers hold at most eight increasing samples. The canvas loop runs at display cadence and renders at `now - 100 ms`, linearly interpolating across the surrounding samples. If an ordinary gap puts the render time slightly after the newest sample, velocity extrapolation is limited to 120 ms; after that the cursor holds. Consequently memory and prediction error remain bounded even if packets stop.

Network packets update refs and buffers, never React state for each cursor. React only updates room/presence/status/telemetry at human-visible frequencies.

## 6. Reconnect and heartbeat

Client connection states are `CONNECTING → SYNCHRONIZING → CONNECTED`, then `RECONNECTING` on close. Retry delays are 500 ms, 1 s, 2 s, 4 s, 8 s, then 10 s until disposed. A welcome snapshot is always accepted afresh after reconnect, clearing obsolete render buffers.

Server heartbeats run every 10 seconds. The browser automatically answers server pings; any normal accepted message also counts as liveness. At 30 seconds without accepted activity, the socket is terminated. Client-initiated pings produce echoed timestamps for RTT and jitter telemetry.

The process installs `SIGINT`/`SIGTERM` handlers that stop the WebSocket server and then the HTTP server before exiting. `httpServer` and `webSocketServer` register persistent `error` listeners so a post-start socket failure logs instead of crashing the process. `GET /` reports `{ ok, rooms, clients, uptimeMs }` for load balancer probes.

## 7. Scaling discussion

This process supports the assignment’s small room target. Multiple Node instances cannot independently own the same room: they would have divergent presence/latest state and no way to broadcast across process boundaries. A scaled design requires routing or a shared registry plus pub/sub fan-out (for example, Redis), durable/authenticated session management, backpressure limits, observability, TLS termination, and room sharding. None are silently implied by this demo.

## 8. Explicit guarantees and non-guarantees

| Guaranteed in scope | Not guaranteed |
| --- | --- |
| Runtime validation prevents malformed messages from changing state | Durable history or recovery after server restart |
| One active connection per resumed client ID in a room | Authentication or authorization |
| Strictly increasing accepted inbound sequence per client | Global ordering across rooms/processes |
| Room-local event ID order for reactions | Reliable delivery after a connection has closed |
| Bounded cursor state, buffers, payloads, extrapolation | Horizontal scalability or exactly-once delivery |
| Clean/stale disconnect removes presence and latest cursor | Perfect visual synchronization across unsynchronized clocks |

The system favors safety and smoothness over pretending to provide stronger distributed guarantees than a single in-memory server can actually provide.
