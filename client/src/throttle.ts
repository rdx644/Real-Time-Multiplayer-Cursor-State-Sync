export interface Point {
  x: number;
  y: number;
}

export const CURSOR_RATE_LIMITS = { min: 15, max: 30 } as const;

export function cursorRateForRtt(rttMs: number | null): number {
  if (rttMs === null || rttMs < 50) return 30;
  if (rttMs < 100) return 25;
  if (rttMs < 200) return 20;
  return 15;
}

export function interpolationDelayForRtt(rttMs: number | null): number {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs < 0) return 100;
  if (rttMs < 50) return 50;
  if (rttMs < 100) return 70;
  if (rttMs < 200) return 100;
  if (rttMs < 300) return 120;
  return 140;
}

/**
 * Latest-value throttling: under a pointer-event burst, only the newest point
 * is emitted when the current rate slot opens. It never queues an old path.
 */
export class CursorThrottler {
  private latest: Point | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private intervalMs: number;

  constructor(
    private readonly send: (point: Point) => void,
    initialRateHz: number = CURSOR_RATE_LIMITS.max,
    private readonly now: () => number = () => performance.now()
  ) {
    this.intervalMs = 1_000 / this.clampRate(initialRateHz);
  }

  push(point: Point): void {
    this.latest = point;
    this.schedule();
  }

  setRateHz(rateHz: number): void {
    this.intervalMs = 1_000 / this.clampRate(rateHz);
    if (this.latest) {
      this.clearTimer();
      this.schedule();
    }
  }

  flush(): void {
    this.clearTimer();
    if (!this.latest) return;
    const point = this.latest;
    this.latest = null;
    this.lastSentAt = this.now();
    this.send(point);
  }

  dispose(): void {
    this.latest = null;
    this.clearTimer();
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.intervalMs - (this.now() - this.lastSentAt));
    if (wait === 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clampRate(rateHz: number): number {
    return Math.min(CURSOR_RATE_LIMITS.max, Math.max(CURSOR_RATE_LIMITS.min, rateHz));
  }
}
