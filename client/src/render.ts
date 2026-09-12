import type { RenderedCursor } from "./interpolation.js";
import type { Point } from "./throttle.js";

interface Reaction extends Point {
  eventId: number;
  createdAt: number;
}

const REACTION_LIFETIME_MS = 1_100;

function colorFor(clientId: string): string {
  let hash = 2166136261;
  for (const char of clientId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `hsl(${Math.abs(hash) % 360} 82% 65%)`;
}

/** Canvas is deliberately independent of React and the WebSocket transport. */
export class CanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly reactions: Reaction[] = [];
  private logicalWidth = 1;
  private logicalHeight = 1;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is not available.");
    this.context = context;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  pointFromEvent(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    };
  }

  center(): Point {
    return { x: this.logicalWidth / 2, y: this.logicalHeight / 2 };
  }

  addReaction(point: Point, eventId: number, createdAt = performance.now()): void {
    if (this.reactions.some((reaction) => reaction.eventId === eventId)) return;
    this.reactions.push({ ...point, eventId, createdAt });
  }

  render(cursors: readonly RenderedCursor[], now = performance.now()): void {
    const context = this.context;
    context.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
    this.drawGrid();
    for (const cursor of cursors) this.drawCursor(cursor);
    this.drawReactions(now);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.reactions.splice(0);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.logicalWidth = Math.max(1, rect.width);
    this.logicalHeight = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.logicalWidth * dpr);
    this.canvas.height = Math.round(this.logicalHeight * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private drawGrid(): void {
    const context = this.context;
    context.save();
    context.strokeStyle = "rgba(148, 163, 184, 0.10)";
    context.lineWidth = 1;
    for (let x = 24; x < this.logicalWidth; x += 24) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, this.logicalHeight); context.stroke();
    }
    for (let y = 24; y < this.logicalHeight; y += 24) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(this.logicalWidth, y); context.stroke();
    }
    context.restore();
  }

  private drawCursor(cursor: RenderedCursor): void {
    const context = this.context;
    const color = colorFor(cursor.clientId);
    context.save();
    context.translate(cursor.x, cursor.y);
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(0, 0); context.lineTo(3, 18); context.lineTo(8, 12); context.lineTo(14, 18); context.lineTo(17, 15); context.closePath();
    context.fill();
    context.fillStyle = "rgba(15, 23, 42, .92)";
    context.font = "600 11px ui-sans-serif, system-ui";
    context.fillText(cursor.clientId.slice(0, 6), 20, 18);
    context.restore();
  }

  private drawReactions(now: number): void {
    const context = this.context;
    for (let index = this.reactions.length - 1; index >= 0; index -= 1) {
      const reaction = this.reactions[index]!;
      const progress = (now - reaction.createdAt) / REACTION_LIFETIME_MS;
      if (progress >= 1) {
        this.reactions.splice(index, 1);
        continue;
      }
      context.save();
      context.globalAlpha = 1 - progress;
      context.font = `${22 + progress * 12}px ui-sans-serif, system-ui`;
      context.fillText("♥", reaction.x - 10, reaction.y - progress * 48);
      context.restore();
    }
  }
}
