import { describe, expect, it } from "vitest";
import { Room, SOCKET_OPEN, SLOW_CONSUMER_BUFFER_BYTES, type SocketLike } from "./room.js";

class FakeSocket implements SocketLike {
  readyState = SOCKET_OPEN;
  bufferedAmount = 0;
  terminated = false;
  readonly messages: string[] = [];
  send(data: string): void { this.messages.push(data); }
  terminate(): void { this.terminated = true; this.readyState = 3; }
}

function client(id: string, socket = new FakeSocket()) {
  return { id, socket, joinedAt: 1, lastSeenAt: 1, lastClientSeq: 0 };
}

describe("Room", () => {
  it("performs O(n) fan-out only to open, non-excluded sockets", () => {
    const room = new Room("lobby");
    const a = client("a");
    const b = client("b");
    const closed = client("closed");
    closed.socket.readyState = 3;
    room.add(a); room.add(b); room.add(closed);

    room.broadcast({ type: "presence", participants: [] }, "a");

    expect(a.socket.messages).toHaveLength(0);
    expect(b.socket.messages).toHaveLength(1);
    expect(closed.socket.messages).toHaveLength(0);
  });

  it("stores only a latest cursor snapshot and never cursor history", () => {
    const room = new Room("lobby");
    const a = client("a");
    room.add(a);
    room.updateCursor(a, { type: "cursor", clientId: "a", seq: 1, timestamp: 1, x: 10, y: 20 }, 2);
    room.updateCursor(a, { type: "cursor", clientId: "a", seq: 2, timestamp: 3, x: 30, y: 40 }, 4);

    expect(room.cursorSnapshot()).toEqual([{ clientId: "a", seq: 2, timestamp: 3, serverTimestamp: 4, x: 30, y: 40 }]);
  });

  it("does not let a delayed close remove a replacement socket", () => {
    const room = new Room("lobby");
    const oldClient = client("a");
    const replacement = client("a");
    room.add(oldClient);
    room.add(replacement);

    expect(room.remove("a", oldClient.socket)).toBe(false);
    expect(room.get("a")).toBe(replacement);
    expect(room.remove("a", replacement.socket)).toBe(true);
  });

  it("drops a slow consumer instead of letting its buffer grow unbounded", () => {
    const room = new Room("lobby");
    const healthy = client("healthy");
    const slow = client("slow");
    slow.socket.bufferedAmount = SLOW_CONSUMER_BUFFER_BYTES + 1;
    room.add(healthy); room.add(slow);

    room.broadcast({ type: "presence", participants: [] });

    expect((slow.socket as FakeSocket).terminated).toBe(true);
    expect(healthy.socket.messages).toHaveLength(1);
  });
});
