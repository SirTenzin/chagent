/**
 * Pi adapter — writer.
 *
 * Target format: `<piHome>/sessions/--<encoded-cwd>--/<iso-ts>_<uuidv7>.jsonl`,
 * a linear JSONL chain: a `session` header, then entries (`message`,
 * `model_change`, `compaction`, …) linked by `id`/`parentId`. Tool results are
 * standalone `message` entries with role `toolResult`; subagent runs are
 * sidecar files under `<session-basename>/<8hex>/run-N/session.jsonl`.
 *
 * The writer never touches the real `~/.pi` unless the caller passes it as
 * `piHome` — tests point it at a scratch directory.
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { uuidv7 } from "../util.ts";
import { text } from "../text.ts";
import type {
  IRChildSession,
  IRMessage,
  IRSession,
  IRToolCallPart,
  IRToolResultPart,
} from "../ir.ts";

const PI_SESSION_VERSION = 3;

export interface WriteResult {
  filePath: string;
  /** native session id (the uuidv7 in the filename) */
  sessionId: string;
  /** id form shown to the user (matches the one in resumeHint) */
  displayId: string;
  /** how to open the result, e.g. for the CLI's final output line */
  resumeHint: string;
}

export function encodePiCwd(cwd: string): string {
  // observed: only "/" becomes "-"; dots and spaces survive literally
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
}

export async function writePiSession(
  ir: IRSession,
  piHome: string,
): Promise<WriteResult> {
  const createdAt = ir.createdAt ?? Date.now();
  const sessionId = uuidv7(createdAt);
  const dir = join(piHome, "sessions", encodePiCwd(ir.cwd));
  const basename = `${isoForFilename(createdAt)}_${sessionId}`;
  const filePath = join(dir, `${basename}.jsonl`);

  await mkdir(dir, { recursive: true });
  await Bun.write(filePath, renderSession(ir, sessionId, createdAt));

  for (let i = 0; i < ir.children.length; i++) {
    await writeChild(ir.children[i]!, join(dir, basename));
  }

  if (ir.extensions.length > 0) {
    // lane-2 sidecar: Pi only scans *.jsonl, so a .json next to the session
    // is invisible to it but lets a future Pi→origin conversion restore
    await Bun.write(
      join(dir, `${basename}.chagent.json`),
      JSON.stringify({ chagent: 1, source: ir.source, extensions: ir.extensions }),
    );
  }

  // pi --session accepts a partial UUID resolved against the cwd's sessions
  // (verified via pi --help), so the short 8-char form works
  const displayId = sessionId.slice(0, 8);
  return { filePath, sessionId, displayId, resumeHint: text.resumePi(displayId) };
}

async function writeChild(
  child: IRChildSession,
  sidecarRoot: string,
): Promise<void> {
  const runDir = join(sidecarRoot, entryId(), "run-0");
  await mkdir(runDir, { recursive: true });
  const createdAt = child.session.createdAt ?? Date.now();
  const name =
    child.description ??
    (child.agentType !== undefined ? `subagent-${child.agentType}` : undefined);
  await Bun.write(
    join(runDir, "session.jsonl"),
    renderSession(child.session, uuidv7(createdAt), createdAt, name),
  );
  for (const nested of child.session.children) {
    await writeChild(nested, runDir);
  }
}

function renderSession(
  ir: IRSession,
  sessionId: string,
  createdAt: number,
  sessionName?: string,
): string {
  const out = new Chain(createdAt);
  out.push({
    type: "session",
    version: PI_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(createdAt).toISOString(),
    cwd: ir.cwd,
  });
  if (sessionName !== undefined) {
    out.pushChained({ type: "session_info", name: sessionName }, createdAt);
  }

  const ctx: WriteCtx = {
    callNames: collectCallNames(ir),
    emittedCalls: new Set(),
    deferred: new Map(),
  };
  let currentModel: string | undefined;

  for (const message of ir.messages) {
    const ts = message.timestamp ?? createdAt;
    if (message.role === "assistant") {
      const modelKey = `${message.model?.provider}/${message.model?.id}`;
      if (message.model?.id !== undefined && modelKey !== currentModel) {
        currentModel = modelKey;
        out.pushChained(
          {
            type: "model_change",
            provider: message.model.provider ?? "unknown",
            modelId: message.model.id,
          },
          ts,
        );
      }
      writeAssistant(out, message, ts, ctx);
    } else {
      writeUser(out, message, ctx, ts);
    }
  }
  // results whose calls never appeared (fork gaps) still land at the end
  for (const [, d] of ctx.deferred) emitToolResult(out, d.part, d.ts, ctx);
  out.resolveCompactions();
  return out.render();
}

interface WriteCtx {
  callNames: Map<string, string>;
  emittedCalls: Set<string>;
  /** results seen before their call in source order — Pi replays require
   * call-before-result, so they wait for the call's assistant message */
  deferred: Map<string, { part: IRToolResultPart; ts: number }>;
}

function writeAssistant(
  out: Chain,
  message: IRMessage,
  ts: number,
  ctx: WriteCtx,
): void {
  const content: unknown[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "thinking":
        content.push({
          type: "thinking",
          thinking: part.text,
          // signatures are provider-bound: Anthropic signatures ride along
          // (Pi's anthropic-messages path stores them in the same slot),
          // anything else is stripped
          thinkingSignature:
            part.signature?.provider === "anthropic"
              ? String(part.signature.data)
              : "",
        });
        break;
      case "toolCall":
        content.push({
          type: "toolCall",
          id: part.callId,
          name: part.name,
          arguments: part.input ?? {},
        });
        break;
      case "compaction":
        out.pushCompaction(part.summary ?? "", ts);
        break;
      default:
        // lane 2: foreign bookkeeping parts stay out of the transcript
        break;
    }
  }
  if (content.length === 0) return;

  const lastPart = message.parts.at(-1);
  const usage = message.usage;
  out.pushChained(
    {
      type: "message",
      message: {
        role: "assistant",
        api: apiFor(message.model?.provider),
        provider: message.model?.provider ?? "unknown",
        model: message.model?.id ?? "unknown",
        content,
        usage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          cacheRead: usage?.cacheReadTokens ?? 0,
          cacheWrite: usage?.cacheWriteTokens ?? 0,
          totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: usage?.costUsd ?? 0,
          },
        },
        stopReason: lastPart?.type === "toolCall" ? "toolUse" : "stop",
        timestamp: ts,
      },
    },
    ts,
  );

  for (const part of message.parts) {
    if (part.type !== "toolCall") continue;
    ctx.emittedCalls.add(part.callId);
    const waiting = ctx.deferred.get(part.callId);
    if (waiting !== undefined) {
      ctx.deferred.delete(part.callId);
      emitToolResult(out, waiting.part, waiting.ts, ctx);
    }
  }
}

/**
 * A user-role IR message can interleave typed text, tool results, images and
 * attachments (Claude Code batches them into one record). Pi wants tool
 * results as standalone entries, so parts stream out in order: contiguous
 * user-visible parts group into one user message, results break the group.
 */
function writeUser(
  out: Chain,
  message: IRMessage,
  ctx: WriteCtx,
  ts: number,
): void {
  let userContent: { type: "text"; text: string }[] = [];
  const flush = () => {
    if (userContent.length === 0) return;
    out.pushChained(
      {
        type: "message",
        message: { role: "user", content: userContent, timestamp: ts },
      },
      ts,
    );
    userContent = [];
  };

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        userContent.push({ type: "text", text: part.text });
        break;
      case "image":
        // no observed schema for user-message images in Pi — lane 3
        userContent.push({ type: "text", text: `[image: ${part.mediaType}]` });
        break;
      case "attachment":
        userContent.push({
          type: "text",
          text: part.path !== undefined ? `@${part.path}\n${part.text ?? ""}` : part.text ?? "",
        });
        break;
      case "toolResult": {
        flush();
        const callPending =
          !ctx.emittedCalls.has(part.callId) &&
          ctx.callNames.has(part.callId);
        if (callPending) {
          // source order had this result before its call — hold it for the
          // assistant message that carries the call
          ctx.deferred.set(part.callId, { part, ts });
        } else {
          emitToolResult(out, part, ts, ctx);
        }
        break;
      }
      case "compaction":
        flush();
        out.pushCompaction(part.summary ?? "", ts);
        break;
      default:
        break; // lane 2
    }
  }
  flush();
}

function emitToolResult(
  out: Chain,
  part: IRToolResultPart,
  ts: number,
  ctx: WriteCtx,
): void {
  const content: unknown[] = [{ type: "text", text: part.text }];
  for (const image of part.rich ?? []) {
    content.push({ type: "image", data: image.data, mimeType: image.mediaType });
  }
  out.pushChained(
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: part.callId,
        toolName: part.name ?? ctx.callNames.get(part.callId) ?? "unknown",
        content,
        isError: part.isError,
        timestamp: ts,
        ...(isRecord(part.structured) && { details: part.structured }),
      },
    },
    ts,
  );
}

function collectCallNames(ir: IRSession): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of ir.messages) {
    for (const part of message.parts) {
      if (part.type === "toolCall") {
        names.set(part.callId, (part as IRToolCallPart).name);
      }
    }
  }
  return names;
}

function apiFor(provider: string | undefined): string {
  return provider === "anthropic" ? "anthropic-messages" : provider ?? "unknown";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** builds the id/parentId-linked entry list */
class Chain {
  private entries: Record<string, unknown>[] = [];
  private lastId: string | null = null;
  /** compaction entries whose firstKeptEntryId awaits the next entry's id */
  private pendingCompactions: Record<string, unknown>[] = [];

  constructor(private readonly fallbackTs: number) {}

  push(entry: Record<string, unknown>): void {
    this.entries.push(entry);
  }

  pushChained(entry: Record<string, unknown>, ts: number): void {
    const id = entryId();
    for (const compaction of this.pendingCompactions) {
      compaction.firstKeptEntryId = id;
    }
    this.pendingCompactions = [];
    this.entries.push({
      ...entry,
      id,
      parentId: this.lastId,
      timestamp: new Date(ts).toISOString(),
    });
    this.lastId = id;
  }

  pushCompaction(summary: string, ts: number): void {
    const id = entryId();
    const entry: Record<string, unknown> = {
      type: "compaction",
      id,
      parentId: this.lastId,
      timestamp: new Date(ts).toISOString(),
      summary,
      firstKeptEntryId: null,
      tokensBefore: 0,
      details: { readFiles: [], modifiedFiles: [] },
      fromHook: false,
    };
    this.entries.push(entry);
    this.pendingCompactions.push(entry);
    this.lastId = id;
  }

  resolveCompactions(): void {
    // a compaction with nothing after it keeps firstKeptEntryId: null
    this.pendingCompactions = [];
  }

  render(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}

function entryId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isoForFilename(ts: number): string {
  return new Date(ts).toISOString().replace(/[:.]/g, "-");
}
