/**
 * Pi adapter — reader + writer.
 *
 * Format: `<piHome>/sessions/--<encoded-cwd>--/<iso-ts>_<uuidv7>.jsonl`,
 * a linear JSONL chain: a `session` header, then entries (`message`,
 * `model_change`, `compaction`, …) linked by `id`/`parentId`. Tool results are
 * standalone `message` entries with role `toolResult`; subagent runs are
 * sidecar files under `<session-basename>/<8hex>/run-N/session.jsonl`.
 *
 * Neither direction touches the real `~/.pi` unless the caller passes it as
 * `piHome`/locator — tests point at scratch directories and read the real
 * store read-only.
 */

import { dirname, join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import { uuidv7 } from "../util.ts";
import { text } from "../text.ts";
import {
  newId,
  type IRChildSession,
  type IRImagePart,
  type IRMessage,
  type IRPart,
  type IRSession,
  type IRToolCallPart,
  type IRToolResultPart,
  type ReadIssue,
  type ReadResult,
  type SessionRef,
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

// ---------------------------------------------------------------------------
// reader
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

export async function listPiSessions(piHome: string): Promise<SessionRef[]> {
  const root = join(piHome, "sessions");
  const refs: SessionRef[] = [];
  const dirs = await readdir(root).catch(() => [] as string[]);
  for (const dir of dirs) {
    const files = await readdir(join(root, dir)).catch(() => [] as string[]);
    for (const file of files) {
      const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
        file,
      );
      if (match === null) continue;
      const locator = join(root, dir, file);
      const ref: SessionRef = { harness: "pi", id: match[1]!, locator };
      const st = await stat(locator).catch(() => null);
      if (st !== null) ref.updatedAt = st.mtimeMs;
      try {
        const head = await Bun.file(locator).slice(0, 8192).text();
        const header = JSON.parse(head.split("\n", 1)[0]!);
        if (typeof header.cwd === "string") ref.cwd = header.cwd;
      } catch {
        // unreadable/partial header — the ref still lists, read reports it
      }
      refs.push(ref);
    }
  }
  return refs;
}

export async function readPiSession(locator: string): Promise<ReadResult> {
  const issues: ReadIssue[] = [];
  const session = await parsePiSession(locator, issues);
  return { session, issues };
}

async function parsePiSession(
  path: string,
  issues: ReadIssue[],
): Promise<IRSession> {
  const session: IRSession = {
    id: newId(),
    source: { harness: "pi", id: "", locator: path },
    cwd: "",
    messages: [],
    children: [],
    extensions: [],
  };

  const lines = (await Bun.file(path).text()).split("\n");
  let currentModel: { provider?: string; id?: string } | undefined;
  let expectedParent: string | null = null;
  /** whether the previous entry was a toolResult (they batch into one
   * user-role IR message, mirroring how Claude Code groups them) */
  let inResultBatch = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let entry: Rec;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      const kind = i === lines.length - 1 ? "truncated-tail" : "bad-json";
      issues.push({ line: i + 1, kind, detail: String(err) });
      continue;
    }

    const ts = entryTs(entry);
    if (ts !== undefined) {
      session.createdAt ??= ts;
      session.updatedAt = ts;
    }

    if (entry.type === "session") {
      if (session.cwd === "" && typeof entry.cwd === "string") {
        session.cwd = entry.cwd;
      } else if (session.cwd !== "") {
        issues.push({ line: i + 1, kind: "duplicate-session-header", detail: "" });
      }
      if (typeof entry.id === "string") session.source.id = entry.id;
      if (entry.version !== PI_SESSION_VERSION) {
        issues.push({
          line: i + 1,
          kind: "unknown-session-version",
          detail: String(entry.version),
        });
      }
      continue;
    }

    // linear id/parentId chain — breaks are data quirks, not fatal
    if (entry.parentId !== expectedParent) {
      issues.push({
        line: i + 1,
        kind: "chain-break",
        detail: `parentId ${String(entry.parentId)} != ${String(expectedParent)}`,
      });
    }
    if (typeof entry.id === "string") expectedParent = entry.id;

    if (entry.type !== "message") inResultBatch = false;
    switch (entry.type) {
      case "model_change":
        currentModel = {
          provider: typeof entry.provider === "string" ? entry.provider : undefined,
          id: typeof entry.modelId === "string" ? entry.modelId : undefined,
        };
        break;
      case "session_info":
        if (typeof entry.name === "string") session.title ??= entry.name;
        pushPiExtension(session, "session_info", entry);
        break;
      case "compaction": {
        const meta: Record<string, unknown> = {};
        for (const key of ["firstKeptEntryId", "tokensBefore", "details", "fromHook"]) {
          if (entry[key] !== undefined) meta[key] = entry[key];
        }
        session.messages.push({
          id: newId(),
          role: "user",
          parts: [
            {
              type: "compaction",
              summary: typeof entry.summary === "string" ? entry.summary : "",
              ...(Object.keys(meta).length > 0 && { meta }),
            },
          ],
          ...(ts !== undefined && { timestamp: ts }),
          sourceIds: typeof entry.id === "string" ? [entry.id] : [],
        });
        break;
      }
      case "message":
        inResultBatch = ingestPiMessage(
          entry,
          session,
          currentModel,
          inResultBatch,
          ts,
          issues,
          i + 1,
        );
        break;
      case "thinking_level_change":
      case "custom":
      case "custom_message":
        pushPiExtension(session, String(entry.type), entry);
        break;
      default:
        issues.push({ line: i + 1, kind: "unknown-entry", detail: String(entry.type) });
        pushPiExtension(session, `record:${String(entry.type)}`, entry);
    }
  }

  await readPiChildren(path, session, issues);
  await restoreSidecar(path, session, issues);
  return session;
}

function pushPiExtension(session: IRSession, extType: string, payload: unknown): void {
  session.extensions.push({
    harness: "pi",
    extType,
    position: session.messages.length,
    payload,
  });
}

function entryTs(entry: Rec): number | undefined {
  const message = entry.message as Rec | undefined;
  if (typeof message?.timestamp === "number") return message.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** returns whether the message extended/produced a toolResult batch */
function ingestPiMessage(
  entry: Rec,
  session: IRSession,
  currentModel: { provider?: string; id?: string } | undefined,
  inResultBatch: boolean,
  ts: number | undefined,
  issues: ReadIssue[],
  line: number,
): boolean {
  const message = entry.message as Rec | undefined;
  if (message === undefined) {
    issues.push({ line, kind: "message-no-payload", detail: "" });
    pushPiExtension(session, "record:message", entry);
    return false;
  }
  const sourceIds = typeof entry.id === "string" ? [entry.id] : [];

  switch (message.role) {
    case "user": {
      const parts: IRPart[] = [];
      for (const block of blocksOf(message.content)) {
        if (block.type === "text") {
          parts.push({ type: "text", text: String(block.text ?? "") });
        } else {
          issues.push({ line, kind: "unknown-user-block", detail: String(block.type) });
          parts.push({ type: "extension", harness: "pi", extType: `block:${String(block.type)}`, payload: block });
        }
      }
      session.messages.push({
        id: newId(),
        role: "user",
        parts,
        sourceIds,
        ...(ts !== undefined && { timestamp: ts }),
      });
      return false;
    }
    case "assistant": {
      const parts: IRPart[] = [];
      for (const block of blocksOf(message.content)) {
        switch (block.type) {
          case "text":
            parts.push({ type: "text", text: String(block.text ?? "") });
            break;
          case "thinking": {
            const signature = String(block.thinkingSignature ?? "");
            parts.push({
              type: "thinking",
              text: String(block.thinking ?? ""),
              ...(signature !== "" && {
                signature: {
                  provider: signatureProvider(message.api, message.provider),
                  data: signature,
                },
              }),
            });
            break;
          }
          case "toolCall":
            parts.push({
              type: "toolCall",
              callId: String(block.id ?? ""),
              name: String(block.name ?? ""),
              input: block.arguments,
            });
            break;
          default:
            issues.push({ line, kind: "unknown-assistant-block", detail: String(block.type) });
            parts.push({ type: "extension", harness: "pi", extType: `block:${String(block.type)}`, payload: block });
        }
      }
      const meta: Record<string, unknown> = {};
      for (const key of ["stopReason", "errorMessage", "api", "responseId", "diagnostics"]) {
        if (message[key] !== undefined) meta[key] = message[key];
      }
      const provider =
        typeof message.provider === "string" ? message.provider : currentModel?.provider;
      const modelId = typeof message.model === "string" ? message.model : currentModel?.id;
      session.messages.push({
        id: newId(),
        role: "assistant",
        parts,
        sourceIds,
        ...(ts !== undefined && { timestamp: ts }),
        ...((provider !== undefined || modelId !== undefined) && {
          model: { provider, id: modelId },
        }),
        ...(isRecord(message.usage) && { usage: usageOf(message.usage) }),
        ...(Object.keys(meta).length > 0 && { meta }),
      });
      return false;
    }
    case "toolResult": {
      const texts: string[] = [];
      const rich: IRImagePart[] = [];
      for (const block of blocksOf(message.content)) {
        if (block.type === "text") texts.push(String(block.text ?? ""));
        else if (block.type === "image") {
          rich.push({
            type: "image",
            mediaType: String(block.mimeType ?? block.mediaType ?? "application/octet-stream"),
            data: String(block.data ?? ""),
          });
        } else {
          issues.push({ line, kind: "unknown-result-block", detail: String(block.type) });
        }
      }
      const part: IRToolResultPart = {
        type: "toolResult",
        callId: String(message.toolCallId ?? ""),
        name: typeof message.toolName === "string" ? message.toolName : undefined,
        text: texts.join("\n"),
        isError: message.isError === true,
        ...(rich.length > 0 && { rich }),
        ...(isRecord(message.details) && { structured: message.details }),
      };
      const last = session.messages.at(-1);
      if (inResultBatch && last !== undefined && last.role === "user") {
        last.parts.push(part);
        if (sourceIds.length > 0) last.sourceIds!.push(sourceIds[0]!);
      } else {
        session.messages.push({
          id: newId(),
          role: "user",
          parts: [part],
          sourceIds,
          ...(ts !== undefined && { timestamp: ts }),
        });
      }
      return true;
    }
    case "bashExecution":
      // pi-only role: a raw `!command` the user ran — positional, pi-specific
      session.messages.push({
        id: newId(),
        role: "user",
        parts: [
          { type: "extension", harness: "pi", extType: "bashExecution", payload: message },
        ],
        sourceIds,
        ...(ts !== undefined && { timestamp: ts }),
      });
      return false;
    default:
      issues.push({ line, kind: "unknown-role", detail: String(message.role) });
      pushPiExtension(session, `role:${String(message.role)}`, entry);
      return false;
  }
}

function blocksOf(content: unknown): Rec[] {
  return Array.isArray(content) ? (content as Rec[]) : [];
}

function usageOf(usage: Rec) {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const cost = usage.cost as Rec | undefined;
  return {
    inputTokens: num(usage.input),
    outputTokens: num(usage.output),
    reasoningTokens: num(usage.reasoning),
    cacheReadTokens: num(usage.cacheRead),
    cacheWriteTokens: num(usage.cacheWrite),
    costUsd: num(cost?.total),
  };
}

function signatureProvider(api: unknown, provider: unknown): string {
  const a = String(api ?? "");
  if (a.includes("anthropic")) return "anthropic";
  if (a.includes("openai") || a.includes("codex")) return "openai";
  return typeof provider === "string" ? provider : "unknown";
}

async function readPiChildren(
  path: string,
  session: IRSession,
  issues: ReadIssue[],
): Promise<void> {
  const root = path.endsWith("session.jsonl")
    ? dirname(path)
    : path.replace(/\.jsonl$/, "");
  const entries = await readdir(root).catch(() => null);
  if (entries === null) return;
  for (const entry of entries.sort()) {
    if (!/^[0-9a-f]{8}$/.test(entry)) continue;
    const runs = await readdir(join(root, entry)).catch(() => [] as string[]);
    for (const run of runs.sort()) {
      if (!/^run-\d+$/.test(run)) continue;
      const childPath = join(root, entry, run, "session.jsonl");
      if (!(await Bun.file(childPath).exists())) continue;
      const child = await parsePiSession(childPath, issues);
      const ref: IRChildSession = { session: child };
      // session_info name carries what the writer knew: a description, or
      // the marker form `subagent-<type>`
      if (child.title !== undefined) {
        if (child.title.startsWith("subagent-")) {
          ref.agentType = child.title.slice("subagent-".length);
        } else {
          ref.description = child.title;
        }
      }
      session.children.push(ref);
    }
  }
  // sidecar dir names are random 8-hex — recover a stable order
  session.children.sort(
    (a, b) => (a.session.createdAt ?? 0) - (b.session.createdAt ?? 0),
  );
}

async function restoreSidecar(
  path: string,
  session: IRSession,
  issues: ReadIssue[],
): Promise<void> {
  if (path.endsWith("session.jsonl")) return; // children have no sidecar
  const file = Bun.file(path.replace(/\.jsonl$/, ".chagent.json"));
  if (!(await file.exists())) return;
  try {
    const data = await file.json();
    if (data?.chagent === 1 && Array.isArray(data.extensions)) {
      for (const ext of data.extensions) {
        session.extensions.push({
          ...ext,
          position: Math.min(Number(ext.position ?? 0), session.messages.length),
        });
      }
      const src = data.source ?? {};
      issues.push({
        line: 0,
        kind: "chagent-sidecar",
        detail: `restored ${data.extensions.length} extensions; original source ${String(src.harness)}:${String(src.id)}`,
      });
    }
  } catch (err) {
    issues.push({ line: 0, kind: "bad-sidecar", detail: String(err) });
  }
}
