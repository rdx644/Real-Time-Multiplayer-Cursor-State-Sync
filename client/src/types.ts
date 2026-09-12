export type {
  ClientId,
  CursorState,
  Participant,
  ReactionType,
  ServerMessage
} from "./protocol.js";

export type ConnectionStatus = "CONNECTING" | "SYNCHRONIZING" | "CONNECTED" | "RECONNECTING" | "DISCONNECTED";

export interface SyncMetrics {
  rttMs: number | null;
  jitterMs: number | null;
  txRate: number;
  rxRate: number;
  staleDrops: number;
  reconnects: number;
  cursorRateHz: number;
}
