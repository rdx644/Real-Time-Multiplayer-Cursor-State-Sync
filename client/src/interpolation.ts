import type { ClientId } from "./types.js";
import type { Point } from "./throttle.js";

export interface PositionSample extends Point {
  seq: number;
  receivedAt: number;
  serverTimestamp: number;
}

export interface RenderedCursor extends Point {
  clientId: ClientId;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** A sequence-filtered, bounded sample buffer for one remote client. */
export class RemoteCursorBuffer {
  private readonly samples: PositionSample[] = [];

  constructor(
    private interpolationDelayMs = 100,
    private readonly maxSamples = 8,
    private readonly extrapolationLimitMs = 120
  ) {}

  push(sample: PositionSample): boolean {
    const newest = this.samples.at(-1);
    if (newest && sample.seq <= newest.seq) return false;
    const receivedAt = newest ? Math.max(sample.receivedAt, newest.receivedAt + 0.01) : sample.receivedAt;
    this.samples.push({ ...sample, receivedAt });
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    return true;
  }

  setInterpolationDelay(delayMs: number): void {
    this.interpolationDelayMs = Math.min(140, Math.max(50, delayMs));
  }

  positionAt(now: number): Point | null {
    if (this.samples.length === 0) return null;
    if (this.samples.length === 1) return pointOf(this.samples[0]!);

    const renderTime = now - this.interpolationDelayMs;
    const first = this.samples[0]!;
    const last = this.samples.at(-1)!;
    if (renderTime <= first.receivedAt) return pointOf(first);

    for (let index = 1; index < this.samples.length; index += 1) {
      const after = this.samples[index]!;
      if (after.receivedAt >= renderTime) {
        const before = this.samples[index - 1]!;
        const duration = after.receivedAt - before.receivedAt;
        const alpha = duration > 0 ? clamp((renderTime - before.receivedAt) / duration, 0, 1) : 1;
        return {
          x: before.x + (after.x - before.x) * alpha,
          y: before.y + (after.y - before.y) * alpha
        };
      }
    }

    // Bounded extrapolation keeps a short packet gap natural without allowing drift.
    const elapsed = renderTime - last.receivedAt;
    if (elapsed <= 0 || elapsed > this.extrapolationLimitMs) return pointOf(last);
    const penultimate = this.samples[this.samples.length - 2]!;
    const duration = last.receivedAt - penultimate.receivedAt;
    if (duration <= 0) return pointOf(last);
    return {
      x: last.x + ((last.x - penultimate.x) / duration) * elapsed,
      y: last.y + ((last.y - penultimate.y) / duration) * elapsed
    };
  }

  get length(): number {
    return this.samples.length;
  }
}

function pointOf(sample: PositionSample): Point {
  return { x: sample.x, y: sample.y };
}

export class RemoteCursorStore {
  private readonly buffers = new Map<ClientId, RemoteCursorBuffer>();

  constructor(private readonly options: ConstructorParameters<typeof RemoteCursorBuffer> = []) {}

  push(clientId: ClientId, sample: PositionSample): boolean {
    let buffer = this.buffers.get(clientId);
    if (!buffer) {
      buffer = new RemoteCursorBuffer(...this.options);
      this.buffers.set(clientId, buffer);
    }
    return buffer.push(sample);
  }

  retain(clientIds: ReadonlySet<ClientId>): void {
    for (const clientId of this.buffers.keys()) {
      if (!clientIds.has(clientId)) this.buffers.delete(clientId);
    }
  }

  clear(): void {
    this.buffers.clear();
  }

  setInterpolationDelay(delayMs: number): void {
    for (const buffer of this.buffers.values()) {
      buffer.setInterpolationDelay(delayMs);
    }
  }

  positionsAt(now: number): RenderedCursor[] {
    const positions: RenderedCursor[] = [];
    for (const [clientId, buffer] of this.buffers) {
      const position = buffer.positionAt(now);
      if (position) positions.push({ clientId, ...position });
    }
    return positions;
  }
}
