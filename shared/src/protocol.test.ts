import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "./protocol.js";

const envelope = { clientId: "client-a", seq: 1, timestamp: Date.now() };

describe("protocol validation", () => {
  it("accepts a valid cursor message", () => {
    const result = parseClientMessage(JSON.stringify({ type: "cursor", ...envelope, x: 42.5, y: 18 }));
    expect(result).toEqual({ ok: true, value: { type: "cursor", ...envelope, x: 42.5, y: 18 } });
  });

  it.each([
    ["not json", "invalid_json"],
    [JSON.stringify({ type: "unknown", ...envelope }), "unknown_type"],
    [JSON.stringify({ type: "cursor", ...envelope, x: "4", y: 9 }), "invalid_coordinates"],
    [JSON.stringify({ type: "cursor", ...envelope, x: Infinity, y: 9 }), "invalid_coordinates"],
    [JSON.stringify({ type: "cursor", ...envelope, seq: 0, x: 1, y: 2 }), "invalid_seq"],
    [JSON.stringify({ type: "reaction", ...envelope, x: 1, y: 2, reaction: "fire" }), "invalid_reaction"]
  ])("rejects unsafe client input: %s", (payload, code) => {
    const result = parseClientMessage(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("rejects a malformed server event before browser state can consume it", () => {
    const result = parseServerMessage(JSON.stringify({ type: "cursor", ...envelope, x: 1, y: 2, eventId: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_event");
  });

  it("accepts an explicit welcome snapshot", () => {
    const result = parseServerMessage(JSON.stringify({
      type: "welcome",
      clientId: "client-a",
      roomId: "lobby",
      resumeToken: "random-token",
      participants: [{ clientId: "client-a", joinedAt: Date.now() }],
      cursors: [],
      serverTimestamp: Date.now()
    }));
    expect(result.ok).toBe(true);
  });
});
