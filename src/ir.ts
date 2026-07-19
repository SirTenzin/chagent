/**
 * chagent intermediate representation (IR).
 *
 * Every adapter reads its native session format into this shape and writes
 * this shape back out. Design rationale lives in COMPAT.md §2–§3; the short
 * version:
 *
 * - A session is an ordered list of messages; a message is an ordered list of
 *   parts. Tool results are first-class parts (not roles, not envelopes).
 * - Tool calls and results link via `callId`. Structured extras that ride
 *   alongside the model-visible text (CC `toolUseResult`, OC `state.metadata`,
 *   Pi `details`) live in `structured` on the result part.
 * - Anything harness-specific the model never saw goes to `extensions`
 *   (lane 2: sidecar, restored on round-trip, ignored by other harnesses).
 * - Thinking signatures are provider-bound ciphertext; they survive only
 *   same-provider moves and are stripped otherwise.
 */

export type Harness = "claude" | "opencode" | "pi" | "codex" | (string & {});

export interface IRSession {
  /** chagent-generated UUID for this IR instance */
  id: string;
  source: {
    harness: Harness;
    /** native session id in the source harness */
    id: string;
    /** where the raw session was read from (file path, db key, …) */
    locator?: string;
    /** harness version(s) stamped in the session, in order of appearance */
    versions?: string[];
  };
  /** the session's starting working directory — decides target placement */
  cwd: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: IRMessage[];
  /** subagent runs; linked to a parent toolCall part via `linkedCallId` */
  children: IRChildSession[];
  /** lane-2 sidecar: harness bookkeeping the model never saw */
  extensions: IRExtension[];
}

export interface IRChildSession {
  session: IRSession;
  /** `callId` of the toolCall in the parent session that spawned this run */
  linkedCallId?: string;
  agentType?: string;
  description?: string;
}

export type IRRole = "user" | "assistant";

export interface IRMessage {
  /** chagent-generated UUID */
  id: string;
  role: IRRole;
  parts: IRPart[];
  /** native id(s) this message came from, for round-trip and debugging */
  sourceIds?: string[];
  timestamp?: number;
  /** assistant messages: which model produced this turn */
  model?: { provider?: string; id?: string };
  usage?: IRUsage;
  /** unmapped source envelope fields, preserved verbatim for round-trip */
  meta?: Record<string, unknown>;
}

export interface IRUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export type IRPart =
  | IRTextPart
  | IRThinkingPart
  | IRToolCallPart
  | IRToolResultPart
  | IRImagePart
  | IRAttachmentPart
  | IRCompactionPart
  | IRExtensionPart;

interface PartBase {
  /** unmapped source fields for this part, preserved for round-trip */
  meta?: Record<string, unknown>;
}

export interface IRTextPart extends PartBase {
  type: "text";
  text: string;
}

export interface IRThinkingPart extends PartBase {
  type: "thinking";
  /** plaintext reasoning; may be empty (some harnesses store only ciphertext) */
  text: string;
  /** provider-bound signature/ciphertext — only valid within `provider` */
  signature?: { provider: string; data: unknown };
}

export interface IRToolCallPart extends PartBase {
  type: "toolCall";
  callId: string;
  /** tool name exactly as the source recorded it (open set — see COMPAT.md) */
  name: string;
  input: unknown;
}

export interface IRToolResultPart extends PartBase {
  type: "toolResult";
  callId: string;
  name?: string;
  /** the text the model saw */
  text: string;
  /** non-text blocks the model saw alongside the text (screenshots, …) */
  rich?: IRImagePart[];
  isError: boolean;
  /** structured extras channel (see header comment) */
  structured?: unknown;
}

export interface IRImagePart extends PartBase {
  type: "image";
  mediaType: string;
  /** base64 payload */
  data: string;
}

/** file content injected into the conversation (@-mentions, pasted files) */
export interface IRAttachmentPart extends PartBase {
  type: "attachment";
  path?: string;
  mime?: string;
  text?: string;
}

/** a context-compaction boundary: everything before it was summarized */
export interface IRCompactionPart extends PartBase {
  type: "compaction";
  summary?: string;
  auto?: boolean;
}

/**
 * Lane-3-adjacent escape hatch: a model-visible source component with no IR
 * equivalent, kept at its original position. Writers for the origin harness
 * restore it verbatim; others degrade it (tool-shaped → passthrough call,
 * else text).
 */
export interface IRExtensionPart extends PartBase {
  type: "extension";
  harness: Harness;
  extType: string;
  payload: unknown;
}

export interface IRExtension {
  harness: Harness;
  extType: string;
  /**
   * index into `messages` before which this record occurred
   * (`messages.length` = after the last message)
   */
  position: number;
  payload: unknown;
}

export function newId(): string {
  return crypto.randomUUID();
}
