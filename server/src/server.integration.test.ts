import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createRealtimeServer, type RealtimeServer } from "./server.js";

interface ReceivedMessage { type: string; [key: string]: unknown }

class TestClient {
  readonly socket: WebSocket;
  private readonly messages: ReceivedMessage[] = [];
  private readonly waiters: Array<{ predicate: (message: ReceivedMessage) => boolean; resolve: (message: ReceivedMessage) => void }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ReceivedMessage;
      const waiterIndex = this.waiters.findIndex(({ predicate }) => predicate(message));
      if (waiterIndex >= 0) {
        const waiter = this.waiters.splice(waiterIndex, 1)[0]!;
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    return this;
  }

  waitFor(predicate: (message: ReceivedMessage) => boolean): Promise<ReceivedMessage> {
    const queuedIndex = this.messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]!);
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

describe("real-time WebSocket integration", () => {
  let server: RealtimeServer | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await server?.stop();
    server = undefined;
  });

  it("synchronizes room state while rejecting malformed, spoofed, and stale input", async () => {
    server = createRealtimeServer();
    await server.start(0);
    const a = await new TestClient(`${server.address()}?room=demo`).open(); clients.push(a);
    const welcomeA = await a.waitFor((message) => message.type === "welcome");
    const aId = welcomeA.clientId as string;

    const b = await new TestClient(`${server.address()}?room=demo`).open(); clients.push(b);
    const welcomeB = await b.waitFor((message) => message.type === "welcome");
    const bId = welcomeB.clientId as string;
    expect((welcomeB.participants as unknown[])).toHaveLength(2);

    const cursorOnB = b.waitFor((message) => message.type === "cursor" && message.clientId === aId);
    a.send({ type: "cursor", clientId: aId, seq: 1, timestamp: Date.now(), x: 320, y: 180 });
    expect(await cursorOnB).toMatchObject({ x: 320, y: 180, eventId: 1 });

    const reactionOnA = a.waitFor((message) => message.type === "reaction" && message.clientId === bId);
    b.send({ type: "reaction", clientId: bId, seq: 1, timestamp: Date.now(), x: 20, y: 30, reaction: "heart" });
    expect(await reactionOnA).toMatchObject({ eventId: 2, reaction: "heart" });

    const invalid = a.waitFor((message) => message.type === "error" && message.code === "unknown_type");
    a.socket.send(JSON.stringify({ type: "unknown", clientId: aId, seq: 2, timestamp: Date.now() }));
    await expect(invalid).resolves.toMatchObject({ code: "unknown_type" });

    const spoofed = a.waitFor((message) => message.type === "error" && message.code === "identity_mismatch");
    a.send({ type: "cursor", clientId: bId, seq: 2, timestamp: Date.now(), x: 1, y: 2 });
    await expect(spoofed).resolves.toMatchObject({ code: "identity_mismatch" });

    const stale = a.waitFor((message) => message.type === "error" && message.code === "stale_sequence");
    a.send({ type: "cursor", clientId: aId, seq: 1, timestamp: Date.now(), x: 1, y: 2 });
    await expect(stale).resolves.toMatchObject({ code: "stale_sequence" });

    const departure = b.waitFor((message) => message.type === "presence" && (message.participants as unknown[]).length === 1);
    await a.close();
    await expect(departure).resolves.toMatchObject({ type: "presence" });
  });

  it("resumes one logical identity without duplicate presence and retains sequence ordering", async () => {
    server = createRealtimeServer();
    await server.start(0);
    const a = await new TestClient(`${server.address()}?room=resume`).open(); clients.push(a);
    const welcomeA = await a.waitFor((message) => message.type === "welcome");
    const aId = welcomeA.clientId as string;
    const token = welcomeA.resumeToken as string;
    const b = await new TestClient(`${server.address()}?room=resume`).open(); clients.push(b);
    await b.waitFor((message) => message.type === "welcome");

    a.send({ type: "cursor", clientId: aId, seq: 1, timestamp: Date.now(), x: 10, y: 10 });
    await b.waitFor((message) => message.type === "cursor" && message.clientId === aId);
    await a.close();

    const a2 = await new TestClient(`${server.address()}?room=resume&resume=${encodeURIComponent(token)}`).open(); clients.push(a2);
    const welcomeA2 = await a2.waitFor((message) => message.type === "welcome");
    expect(welcomeA2.clientId).toBe(aId);
    expect((welcomeA2.participants as unknown[])).toHaveLength(2);

    const cursorOnB = b.waitFor((message) => message.type === "cursor" && message.clientId === aId && message.seq === 2);
    a2.send({ type: "cursor", clientId: aId, seq: 2, timestamp: Date.now(), x: 20, y: 20 });
    await expect(cursorOnB).resolves.toMatchObject({ x: 20, y: 20 });
    expect(server.rooms.get("resume")?.size).toBe(2);
  });

  it("rejects browser handshakes from an unapproved origin", async () => {
    server = createRealtimeServer({ allowedOrigins: new Set(["https://ok.example"]) });
    await server.start(0);

    const allowed = new WebSocket(server.address(), { origin: "https://ok.example" });
    await new Promise<void>((resolve, reject) => {
      allowed.once("open", () => resolve());
      allowed.once("error", reject);
    });

    const evil = new WebSocket(server.address(), { origin: "https://evil.example" });
    const evilFailure = await new Promise<Error>((resolve) => evil.once("error", resolve));
    expect(evilFailure.message).toMatch(/403|Forbidden|Unexpected server response/i);

    allowed.close();
  });

  it("exposes a health endpoint with room and client metrics", async () => {
    server = createRealtimeServer();
    await server.start(0);
    const httpUrl = server.address().replace("ws://", "http://").replace(/\/ws$/, "/");
    const response = await fetch(httpUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; rooms: number; clients: number; uptimeMs: number };
    expect(body).toMatchObject({ ok: true, rooms: 0, clients: 0 });
    expect(typeof body.uptimeMs).toBe("number");
  });
});
