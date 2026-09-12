/**
 * The wire contract is intentionally dependency-free. Both endpoints validate
 * untrusted data at their boundary before it can affect synchronization state.
 */
export const MAX_PAYLOAD_BYTES = 8 * 1024;
export const MAX_COORDINATE = 100_000;
export const MAX_ROOM_ID_LENGTH = 64;
export const MAX_CLIENT_ID_LENGTH = 128;

export type ClientId = string;
export type ReactionType = "heart";

export interface Participant {
  clientId: ClientId;
  joinedAt: number;
}

export interface CursorState {
  clientId: ClientId;
  x: number;
  y: number;
  seq: number;
  timestamp: number;
  serverTimestamp: number;
}

interface ClientEnvelope {
  clientId: ClientId;
  seq: number;
  timestamp: number;
}

export interface CursorMessage extends ClientEnvelope {
  type: "cursor";
  x: number;
  y: number;
}

export interface ReactionMessage extends ClientEnvelope {
  type: "reaction";
  x: number;
  y: number;
  reaction: ReactionType;
}

export interface ClientPingMessage extends ClientEnvelope {
  type: "ping";
}

/** Response to a server heartbeat. `pingId` binds it to the ping request. */
export interface ClientPongMessage extends ClientEnvelope {
  type: "pong";
  pingId: string;
}

export type ClientMessage =
  | CursorMessage
  | ReactionMessage
  | ClientPingMessage
  | ClientPongMessage;

export interface WelcomeMessage {
  type: "welcome";
  clientId: ClientId;
  roomId: string;
  resumeToken: string;
  participants: Participant[];
  cursors: CursorState[];
  serverTimestamp: number;
}

export interface PresenceMessage {
  type: "presence";
  participants: Participant[];
}

export interface ServerCursorMessage extends CursorMessage {
  eventId: number;
  serverTimestamp: number;
}

export interface ServerReactionMessage extends ReactionMessage {
  eventId: number;
  serverTimestamp: number;
}

/** A server heartbeat. The client replies with a ClientPongMessage. */
export interface ServerPingMessage {
  type: "ping";
  pingId: string;
  timestamp: number;
}

/** Reply to a client latency probe; timestamp is echoed from the client probe. */
export interface ServerPongMessage {
  type: "pong";
  clientId: ClientId;
  seq: number;
  timestamp: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | PresenceMessage
  | ServerCursorMessage
  | ServerReactionMessage
  | ServerPingMessage
  | ServerPongMessage
  | ErrorMessage;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const positiveInteger = (value: unknown): value is number =>
  finiteNumber(value) && Number.isSafeInteger(value) && value > 0;

const nonEmptyString = (value: unknown, maxLength = MAX_CLIENT_ID_LENGTH): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const validTimestamp = (value: unknown): value is number =>
  finiteNumber(value) && value >= 0 && value <= Date.now() + 5 * 60_000;

const validCoordinate = (value: unknown): value is number =>
  finiteNumber(value) && Math.abs(value) <= MAX_COORDINATE;

function parseJson(payload: string): ParseResult<Record<string, unknown>> {
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Payload exceeds the size limit." };
  }

  try {
    const parsed = object(JSON.parse(payload));
    return parsed
      ? { ok: true, value: parsed }
      : { ok: false, code: "invalid_shape", message: "Message must be a JSON object." };
  } catch {
    return { ok: false, code: "invalid_json", message: "Message is not valid JSON." };
  }
}

function validateEnvelope(value: Record<string, unknown>): ParseResult<ClientEnvelope> {
  if (!nonEmptyString(value.clientId)) {
    return { ok: false, code: "invalid_client_id", message: "clientId must be a non-empty string." };
  }
  if (!positiveInteger(value.seq)) {
    return { ok: false, code: "invalid_seq", message: "seq must be a positive safe integer." };
  }
  if (!validTimestamp(value.timestamp)) {
    return { ok: false, code: "invalid_timestamp", message: "timestamp must be a valid epoch time." };
  }
  return {
    ok: true,
    value: { clientId: value.clientId, seq: value.seq, timestamp: value.timestamp }
  };
}

function validatePoint(value: Record<string, unknown>): ParseResult<{ x: number; y: number }> {
  if (!validCoordinate(value.x) || !validCoordinate(value.y)) {
    return { ok: false, code: "invalid_coordinates", message: "Coordinates must be finite and in range." };
  }
  return { ok: true, value: { x: value.x, y: value.y } };
}

export function parseClientMessage(payload: string): ParseResult<ClientMessage> {
  const parsed = parseJson(payload);
  if (!parsed.ok) return parsed;

  const { value } = parsed;
  if (!nonEmptyString(value.type, 32)) {
    return { ok: false, code: "invalid_type", message: "type must be a known string." };
  }

  const envelope = validateEnvelope(value);
  if (!envelope.ok) return envelope;

  if (value.type === "cursor" || value.type === "reaction") {
    const point = validatePoint(value);
    if (!point.ok) return point;

    if (value.type === "reaction" && value.reaction !== "heart") {
      return { ok: false, code: "invalid_reaction", message: "Unsupported reaction." };
    }

    return {
      ok: true,
      value: value.type === "cursor"
        ? { type: "cursor", ...envelope.value, ...point.value }
        : { type: "reaction", ...envelope.value, ...point.value, reaction: "heart" }
    };
  }

  if (value.type === "ping") {
    return { ok: true, value: { type: "ping", ...envelope.value } };
  }

  if (value.type === "pong" && nonEmptyString(value.pingId, 128)) {
    return { ok: true, value: { type: "pong", ...envelope.value, pingId: value.pingId } };
  }

  return { ok: false, code: "unknown_type", message: "Message type is not supported." };
}

function parseParticipants(value: unknown): Participant[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const participants: Participant[] = [];
  for (const item of value) {
    const candidate = object(item);
    if (!candidate || !nonEmptyString(candidate.clientId) || !validTimestamp(candidate.joinedAt)) return null;
    participants.push({ clientId: candidate.clientId, joinedAt: candidate.joinedAt });
  }
  return participants;
}

function parseCursors(value: unknown): CursorState[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const cursors: CursorState[] = [];
  for (const item of value) {
    const candidate = object(item);
    if (
      !candidate ||
      !nonEmptyString(candidate.clientId) ||
      !validCoordinate(candidate.x) ||
      !validCoordinate(candidate.y) ||
      !positiveInteger(candidate.seq) ||
      !validTimestamp(candidate.timestamp) ||
      !validTimestamp(candidate.serverTimestamp)
    ) return null;
    cursors.push({
      clientId: candidate.clientId,
      x: candidate.x,
      y: candidate.y,
      seq: candidate.seq,
      timestamp: candidate.timestamp,
      serverTimestamp: candidate.serverTimestamp
    });
  }
  return cursors;
}

/** Validates data received by the browser. The server is still a network boundary. */
export function parseServerMessage(payload: string): ParseResult<ServerMessage> {
  const parsed = parseJson(payload);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (!nonEmptyString(value.type, 32)) {
    return { ok: false, code: "invalid_type", message: "type must be a known string." };
  }

  if (value.type === "welcome") {
    const participants = parseParticipants(value.participants);
    const cursors = parseCursors(value.cursors);
    if (
      !nonEmptyString(value.clientId) ||
      !nonEmptyString(value.roomId, MAX_ROOM_ID_LENGTH) ||
      !nonEmptyString(value.resumeToken, 256) ||
      !participants ||
      !cursors ||
      !validTimestamp(value.serverTimestamp)
    ) return { ok: false, code: "invalid_welcome", message: "Malformed welcome payload." };
    return { ok: true, value: { type: "welcome", clientId: value.clientId, roomId: value.roomId, resumeToken: value.resumeToken, participants, cursors, serverTimestamp: value.serverTimestamp } };
  }

  if (value.type === "presence") {
    const participants = parseParticipants(value.participants);
    return participants ? { ok: true, value: { type: "presence", participants } } : { ok: false, code: "invalid_presence", message: "Malformed presence payload." };
  }

  if (value.type === "cursor" || value.type === "reaction") {
    const envelope = validateEnvelope(value);
    const point = validatePoint(value);
    if (!envelope.ok) return envelope;
    if (!point.ok) return point;
    if (!positiveInteger(value.eventId) || !validTimestamp(value.serverTimestamp)) {
      return { ok: false, code: "invalid_event", message: "Malformed server event metadata." };
    }
    if (value.type === "reaction" && value.reaction !== "heart") {
      return { ok: false, code: "invalid_reaction", message: "Unsupported reaction." };
    }
    return {
      ok: true,
      value: value.type === "cursor"
        ? { type: "cursor", ...envelope.value, ...point.value, eventId: value.eventId, serverTimestamp: value.serverTimestamp }
        : { type: "reaction", ...envelope.value, ...point.value, reaction: "heart", eventId: value.eventId, serverTimestamp: value.serverTimestamp }
    };
  }

  if (value.type === "ping" && nonEmptyString(value.pingId, 128) && validTimestamp(value.timestamp)) {
    return { ok: true, value: { type: "ping", pingId: value.pingId, timestamp: value.timestamp } };
  }

  if (
    value.type === "pong" &&
    nonEmptyString(value.clientId) &&
    positiveInteger(value.seq) &&
    validTimestamp(value.timestamp)
  ) return { ok: true, value: { type: "pong", clientId: value.clientId, seq: value.seq, timestamp: value.timestamp } };

  if (value.type === "error" && nonEmptyString(value.code, 64) && nonEmptyString(value.message, 512)) {
    return { ok: true, value: { type: "error", code: value.code, message: value.message } };
  }

  return { ok: false, code: "unknown_type", message: "Message type is not supported." };
}

export function serialize(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function isValidRoomId(roomId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(roomId);
}
