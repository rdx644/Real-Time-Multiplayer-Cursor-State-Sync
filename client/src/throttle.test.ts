import { describe, expect, it, vi } from "vitest";
import { CursorThrottler, cursorRateForRtt } from "./throttle.js";

describe("CursorThrottler", () => {
  it("sends the latest point at a bounded rate", () => {
    vi.useFakeTimers();
    let now = 0;
    const sent: Array<{ x: number; y: number }> = [];
    const throttler = new CursorThrottler((point) => sent.push(point), 20, () => now);
    throttler.push({ x: 1, y: 1 });
    throttler.push({ x: 2, y: 2 });
    expect(sent).toEqual([{ x: 1, y: 1 }]);

    now = 50;
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }]);
    throttler.dispose();
    vi.useRealTimers();
  });

  it("keeps adaptive rates within the defined safe range", () => {
    expect(cursorRateForRtt(null)).toBe(30);
    expect(cursorRateForRtt(75)).toBe(25);
    expect(cursorRateForRtt(150)).toBe(20);
    expect(cursorRateForRtt(500)).toBe(15);
  });
});
