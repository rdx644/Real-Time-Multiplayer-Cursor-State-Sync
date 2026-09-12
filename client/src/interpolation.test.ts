import { describe, expect, it } from "vitest";
import { RemoteCursorBuffer, RemoteCursorStore } from "./interpolation.js";

describe("RemoteCursorBuffer", () => {
  it("interpolates between buffered samples rather than snapping on arrival", () => {
    const buffer = new RemoteCursorBuffer(100, 8, 120);
    buffer.push({ x: 0, y: 0, seq: 1, receivedAt: 0, serverTimestamp: 1 });
    buffer.push({ x: 100, y: 50, seq: 2, receivedAt: 100, serverTimestamp: 2 });

    expect(buffer.positionAt(150)).toEqual({ x: 50, y: 25 });
  });

  it("drops an out-of-order sequence before it can move a cursor backwards", () => {
    const buffer = new RemoteCursorBuffer();
    expect(buffer.push({ x: 20, y: 20, seq: 4, receivedAt: 10, serverTimestamp: 1 })).toBe(true);
    expect(buffer.push({ x: 2, y: 2, seq: 3, receivedAt: 20, serverTimestamp: 2 })).toBe(false);
    expect(buffer.length).toBe(1);
  });

  it("bounds both retained samples and extrapolation", () => {
    const buffer = new RemoteCursorBuffer(100, 3, 120);
    for (let index = 1; index <= 5; index += 1) {
      buffer.push({ x: index * 10, y: 0, seq: index, receivedAt: index * 100, serverTimestamp: index });
    }
    expect(buffer.length).toBe(3);
    expect(buffer.positionAt(1_000)).toEqual({ x: 50, y: 0 });
  });

  it("removes cursors that are no longer present", () => {
    const store = new RemoteCursorStore();
    store.push("a", { x: 1, y: 1, seq: 1, receivedAt: 0, serverTimestamp: 0 });
    store.push("b", { x: 2, y: 2, seq: 1, receivedAt: 0, serverTimestamp: 0 });
    store.retain(new Set(["a"]));
    expect(store.positionsAt(0).map((cursor) => cursor.clientId)).toEqual(["a"]);
  });
});
