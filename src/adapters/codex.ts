/**
 * Codex adapter — writer.
 *
 * Target format: `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<uuidv7>.jsonl`
 * where every line is `{timestamp, type, payload}`: a `session_meta` header,
 * `turn_context` snapshots, and `response_item` conversation items (message /
 * reasoning / function_call / function_call_output). JSONL is the source of
 * truth, but resume pickers read the `threads` table in `state_5.sqlite` and
 * `session_index.jsonl` — both are updated alongside (COMPAT rule 6).
 *
 * The writer only touches the home the caller provides — tests point it at a
 * scratch directory, never the real `~/.codex`.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import {
  newId,
  type IRChildSession,
  type IRMessage,
  type IRPart,
  type IRSession,
  type IRToolResultPart,
  type ReadIssue,
  type ReadResult,
  type SessionRef,
} from "../ir.ts";
import { uuidv7 } from "../util.ts";
import { text } from "../text.ts";

export interface CodexWriteResult {
  filePath: string;
  sessionId: string;
  /** id form shown to the user (matches the one in resumeHint) */
  displayId: string;
  resumeHint: string;
}

export async function writeCodexSession(
  ir: IRSession,
  codexHome: string,
): Promise<CodexWriteResult> {
  // Codex refuses to continue threads whose session_meta lacks its own base
  // instructions; borrow them from the newest real session in this home
  // (that's this install's own current prompt — never fabricated)
  const baseInstructions = await borrowBaseInstructions(codexHome);
  const result = await writeRollout(ir, codexHome, undefined, baseInstructions);

  // Resume-picker index. chagent NEVER runs DDL or creates harness-internal
  // stores: Codex's own migrations own that schema. If the index (or its
  // tables) isn't there, or an INSERT fails because the schema drifted, the
  // rollout file still stands — the session just won't show in pickers.
  const dbPath = join(codexHome, "state_5.sqlite");
  if (await Bun.file(dbPath).exists()) {
    const db = new Database(dbPath, { readwrite: true });
    try {
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'thread_spawn_edges')",
        )
        .all();
      if (tables.length === 2) {
        db.exec("BEGIN");
        indexThread(db, ir, result, "user");
        db.exec("COMMIT");
      } else {
        console.error(text.codexNoIndexTables);
      }
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      console.error(text.codexIndexFailed(String(err)));
    } finally {
      db.close();
    }
  } else {
    console.error(text.codexNoIndexDb);
  }

  // session_index.jsonl: append-only cache; append only where Codex already
  // maintains one — never create the file on its behalf
  const indexPath = join(codexHome, "session_index.jsonl");
  const indexFile = Bun.file(indexPath);
  if (await indexFile.exists()) {
    const indexLine = JSON.stringify({
      id: result.sessionId,
      thread_name: ir.title ?? "imported by chagent",
      updated_at: new Date(ir.updatedAt ?? Date.now()).toISOString(),
    });
    await Bun.write(indexPath, (await indexFile.text()) + indexLine + "\n");
  }

  // codex resume takes a full UUID or a session name (per codex resume
  // --help); prefixes would parse as names and paths aren't documented,
  // so the hint always carries the full uuid
  return {
    filePath: result.filePath,
    sessionId: result.sessionId,
    displayId: result.sessionId,
    resumeHint: text.resumeCodex(result.sessionId),
  };
}

interface RolloutOut {
  filePath: string;
  sessionId: string;
  children: RolloutOut[];
}

async function writeRollout(
  ir: IRSession,
  codexHome: string,
  parentThreadId: string | undefined,
  baseInstructions: unknown,
): Promise<RolloutOut> {
  const createdAt = ir.createdAt ?? Date.now();
  const id = uuidv7(createdAt);
  const date = new Date(createdAt);
  const dir = join(
    codexHome,
    "sessions",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  );
  // filename timestamp is second-precision ISO with dashes (observed format)
  const fnameTs = date.toISOString().slice(0, 19).replace(/:/g, "-");
  const filePath = join(dir, `rollout-${fnameTs}-${id}.jsonl`);

  const lines: string[] = [];
  const push = (type: string, payload: unknown, ts: number) =>
    lines.push(
      JSON.stringify({ timestamp: new Date(ts).toISOString(), type, payload }),
    );

  push(
    "session_meta",
    {
      id,
      timestamp: new Date(createdAt).toISOString(),
      cwd: ir.cwd,
      originator: "chagent",
      cli_version: "0.0.1-chagent",
      source: "cli",
      thread_source: parentThreadId === undefined ? "user" : "subagent",
      model_provider: firstProvider(ir) ?? "openai",
      ...(baseInstructions !== undefined && {
        base_instructions: baseInstructions,
      }),
      ...(parentThreadId !== undefined && { parent_thread_id: parentThreadId }),
    },
    createdAt,
  );

  const callNames = new Map<string, string>();
  const mappedKind = new Map<string, string>();
  const emittedCalls = new Set<string>();
  const deferred = new Map<string, { part: IRToolResultPart; ts: number }>();
  // compaction windows chain: first window is the pre-compaction context
  const windows = {
    firstId: uuidv7(createdAt),
    prevId: "",
    number: 0,
  };
  windows.prevId = windows.firstId;
  for (const m of ir.messages) {
    for (const p of m.parts) {
      if (p.type === "toolCall") callNames.set(p.callId, p.name);
    }
  }

  // Codex resume replays turns: each is bracketed task_started → task_complete
  // with a shared turn_id stamped onto every response_item. A thread with no
  // completed turns is not continuable (observed live 2026-07-19).
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const modelAt: (string | undefined)[] = new Array(ir.messages.length);
  {
    let next: string | undefined;
    for (let i = ir.messages.length - 1; i >= 0; i--) {
      const m = ir.messages[i]!;
      if (m.role === "assistant" && m.model?.id !== undefined) next = m.model.id;
      modelAt[i] = next;
    }
  }

  const turnState: {
    current: { id: string; startTs: number; lastAgentText: string | null } | null;
  } = { current: null };
  const pushItem: Push = (type, payload, ts) =>
    push(
      type,
      {
        ...(payload as Record<string, unknown>),
        ...(turnState.current !== null && {
          internal_chat_message_metadata_passthrough: {
            turn_id: turnState.current.id,
          },
        }),
      },
      ts,
    );
  const closeTurn = (ts: number) => {
    const turn = turnState.current;
    if (turn === null) return;
    push(
      "event_msg",
      {
        type: "task_complete",
        turn_id: turn.id,
        last_agent_message: turn.lastAgentText,
        completed_at: Math.floor(ts / 1000),
        duration_ms: Math.max(ts - turn.startTs, 0),
      },
      ts,
    );
    turnState.current = null;
  };
  const openTurn = (ts: number, model: string | undefined) => {
    closeTurn(ts);
    const turn = { id: uuidv7(ts), startTs: ts, lastAgentText: null };
    turnState.current = turn;
    push(
      "event_msg",
      {
        type: "task_started",
        turn_id: turn.id,
        started_at: Math.floor(ts / 1000),
        collaboration_mode_kind: "default",
      },
      ts,
    );
    push(
      "turn_context",
      {
        turn_id: turn.id,
        cwd: ir.cwd,
        current_date: new Date(ts).toISOString().slice(0, 10),
        timezone: tz,
        approval_policy: "never",
        sandbox_policy: { type: "read-only" },
        model: model ?? "unknown",
        summary: "auto",
      },
      ts,
    );
  };

  let lastTs = createdAt;
  for (let i = 0; i < ir.messages.length; i++) {
    const message = ir.messages[i]!;
    const ts = message.timestamp ?? createdAt;
    lastTs = ts;
    // a typed user message (not a pure tool-result batch) starts a new turn
    const typedUser =
      message.role === "user" &&
      message.parts.some(
        (p) => p.type === "text" || p.type === "image" || p.type === "attachment",
      );
    if (turnState.current === null || typedUser) openTurn(ts, modelAt[i]);
    emitMessage(pushItem, push, message, ts, callNames, emittedCalls, deferred, windows, mappedKind);
    if (typedUser) {
      push(
        "event_msg",
        {
          type: "user_message",
          message: message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n"),
          images: [],
          local_images: [],
          text_elements: [],
        },
        ts,
      );
    }
    if (message.role === "assistant") {
      const lastText = [...message.parts].reverse().find((p) => p.type === "text");
      if (turnState.current !== null && lastText !== undefined) {
        turnState.current.lastAgentText = lastText.text;
      }
    }
  }
  for (const [, d] of deferred) emitResult(pushItem, d.part, d.ts, mappedKind);
  closeTurn(lastTs);

  await mkdir(dir, { recursive: true });
  await Bun.write(filePath, lines.join("\n") + "\n");

  const children: RolloutOut[] = [];
  for (const child of ir.children) {
    children.push(await writeRollout(child.session, codexHome, id, baseInstructions));
  }

  return { filePath, sessionId: id, children };
}

type Push = (type: string, payload: unknown, ts: number) => void;

interface WindowChain {
  firstId: string;
  prevId: string;
  number: number;
}

function emitMessage(
  push: Push,
  pushRaw: Push,
  message: IRMessage,
  ts: number,
  callNames: Map<string, string>,
  emittedCalls: Set<string>,
  deferred: Map<string, { part: IRToolResultPart; ts: number }>,
  windows: WindowChain,
  mappedKind: Map<string, string>,
): void {
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        push(
          "response_item",
          {
            type: "message",
            role: message.role,
            content: [
              {
                type: message.role === "assistant" ? "output_text" : "input_text",
                text: part.text,
              },
            ],
          },
          ts,
        );
        break;
      case "thinking":
        // ciphertext is provider-bound (rule 2): only plaintext travels, as
        // a summary item; nothing displayable → no item at all
        if (part.text !== "") {
          push(
            "response_item",
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: part.text }],
              content: null,
            },
            ts,
          );
        }
        break;
      case "toolCall": {
        emittedCalls.add(part.callId);
        // Tier-1 mapping (COMPAT §3): bash-shaped → exec_command, edit/write-
        // shaped → apply_patch. Detected by input shape, never by name (tool
        // palettes drift). Unmapped calls pass through — still in model
        // context, but Codex's TUI doesn't render foreign tool names.
        const native = mapToNative(part.input);
        if (native?.kind === "patch") {
          mappedKind.set(part.callId, "patch");
          push(
            "response_item",
            {
              type: "custom_tool_call",
              id: `ctc_${randomHex(25)}`,
              status: "completed",
              call_id: part.callId,
              name: "apply_patch",
              input: native.input,
            },
            ts,
          );
        } else if (native?.kind === "exec") {
          push(
            "response_item",
            {
              type: "function_call",
              name: "exec_command",
              arguments: native.arguments,
              call_id: part.callId,
            },
            ts,
          );
        } else {
          push(
            "response_item",
            {
              type: "function_call",
              name: part.name,
              arguments: JSON.stringify(part.input ?? {}),
              call_id: part.callId,
            },
            ts,
          );
        }
        break;
      }
      case "toolResult": {
        if (!emittedCalls.has(part.callId)) {
          if (callNames.has(part.callId)) {
            // source order had this result before its call — wait for it
            deferred.set(part.callId, { part, ts });
            break;
          }
          // no call exists anywhere (fork gap): an output without a call is
          // invalid in Responses history — lane 3, user text at position
          push(
            "response_item",
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `[tool result: ${part.name ?? "unknown"}]\n${part.text}`,
                },
              ],
            },
            ts,
          );
          break;
        }
        emitResult(push, part, ts, mappedKind);
        break;
      }
      case "image":
        push(
          "response_item",
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `[image: ${part.mediaType}]` }],
          },
          ts,
        );
        break;
      case "attachment":
        push(
          "response_item",
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  part.path !== undefined
                    ? `@${part.path}\n${part.text ?? ""}`
                    : part.text ?? "",
              },
            ],
          },
          ts,
        );
        break;
      case "compaction": {
        windows.number++;
        const windowId = uuidv7(ts);
        pushRaw(
          "compacted",
          {
            message: "",
            replacement_history: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: part.summary ?? "" }],
              },
            ],
            window_id: windowId,
            window_number: windows.number,
            first_window_id: windows.firstId,
            previous_window_id: windows.prevId,
          },
          ts,
        );
        windows.prevId = windowId;
        break;
      }
      default:
        break; // lane 2
    }
  }
}

function emitResult(
  push: Push,
  part: IRToolResultPart,
  ts: number,
  mappedKind: Map<string, string>,
): void {
  // the output item type must mirror the call's envelope
  const isPatch = mappedKind.get(part.callId) === "patch";
  push(
    "response_item",
    {
      type: isPatch ? "custom_tool_call_output" : "function_call_output",
      call_id: part.callId,
      output: part.text,
    },
    ts,
  );
}

/**
 * Tier-1 shape detection: `{command}` is a shell call, `{file_path|path,
 * old_string, new_string}` / `{…, edits[]}` is an edit, `{…, content}` is a
 * write. Names are never consulted — palettes drift across harness versions.
 */
function mapToNative(
  input: unknown,
): { kind: "exec"; arguments: string } | { kind: "patch"; input: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const inp = input as Record<string, unknown>;
  if (typeof inp.command === "string") {
    return {
      kind: "exec",
      arguments: JSON.stringify({
        cmd: inp.command,
        ...(typeof inp.timeout === "number" && { timeout_ms: inp.timeout }),
      }),
    };
  }
  const path =
    typeof inp.file_path === "string"
      ? inp.file_path
      : typeof inp.path === "string"
        ? inp.path
        : undefined;
  if (path === undefined) return undefined;
  if (typeof inp.old_string === "string" && typeof inp.new_string === "string") {
    return { kind: "patch", input: patchUpdate(path, [[inp.old_string, inp.new_string]]) };
  }
  if (Array.isArray(inp.edits)) {
    const hunks: [string, string][] = [];
    for (const e of inp.edits as Record<string, unknown>[]) {
      const oldText = e.oldText ?? e.old_string;
      const newText = e.newText ?? e.new_string;
      if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
      hunks.push([oldText, newText]);
    }
    if (hunks.length === 0) return undefined;
    return { kind: "patch", input: patchUpdate(path, hunks) };
  }
  if (typeof inp.content === "string") {
    return { kind: "patch", input: patchAdd(path, inp.content) };
  }
  return undefined;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prefixLines(s: string, prefix: string): string {
  return s.split("\n").map((line) => prefix + line).join("\n");
}

function patchAdd(path: string, content: string): string {
  return `*** Begin Patch\n*** Add File: ${path}\n${prefixLines(content, "+")}\n*** End Patch`;
}

function patchUpdate(path: string, hunks: [string, string][]): string {
  const body = hunks
    .map(([oldText, newText]) => `${prefixLines(oldText, "-")}\n${prefixLines(newText, "+")}`)
    .join("\n");
  return `*** Begin Patch\n*** Update File: ${path}\n${body}\n*** End Patch`;
}

/**
 * Newest real (non-chagent) session's base_instructions from the target home.
 * This is Codex's own current system prompt on this machine — borrowed, never
 * fabricated. Returns undefined when no real session exists to borrow from.
 */
async function borrowBaseInstructions(codexHome: string): Promise<unknown> {
  const candidates: { path: string; mtime: number }[] = [];
  try {
    const glob = new Bun.Glob("sessions/**/rollout-*.jsonl");
    for await (const rel of glob.scan({ cwd: codexHome, onlyFiles: true })) {
      const full = join(codexHome, rel);
      const mtime = await stat(full)
        .then((s) => s.mtimeMs)
        .catch(() => 0);
      candidates.push({ path: full, mtime });
    }
  } catch {
    return undefined; // fresh/empty target home — nothing to borrow
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates.slice(0, 20)) {
    try {
      const head = await Bun.file(candidate.path).slice(0, 4 << 20).text();
      const meta = JSON.parse(head.split("\n", 1)[0]!);
      if (
        meta?.type === "session_meta" &&
        meta.payload?.originator !== "chagent" &&
        meta.payload?.base_instructions !== undefined
      ) {
        return meta.payload.base_instructions;
      }
    } catch {
      // partial line or unreadable file — try the next candidate
    }
  }
  return undefined;
}

function firstProvider(ir: IRSession): string | undefined {
  for (const m of ir.messages) {
    if (m.model?.provider !== undefined) return m.model.provider;
  }
  return undefined;
}

function indexThread(
  db: Database,
  ir: IRSession,
  rollout: RolloutOut,
  threadSource: string,
): void {
  const created = ir.createdAt ?? Date.now();
  const updated = ir.updatedAt ?? created;
  const firstUser = firstUserText(ir);
  db.query(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source,
       model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used,
       has_user_event, archived, cli_version, first_user_message, model,
       created_at_ms, updated_at_ms, thread_source, preview, recency_at,
       recency_at_ms, history_mode)
     VALUES (?, ?, ?, ?, 'cli', ?, ?, ?, 'read-only', 'never', ?, 1, 0,
       '0.0.1-chagent', ?, ?, ?, ?, ?, ?, ?, ?, 'legacy')`,
  ).run(
    rollout.sessionId,
    rollout.filePath,
    Math.floor(created / 1000),
    Math.floor(updated / 1000),
    firstProvider(ir) ?? "openai",
    ir.cwd,
    ir.title ?? "imported by chagent",
    totalTokens(ir),
    firstUser.slice(0, 500),
    lastModel(ir) ?? null,
    created,
    updated,
    threadSource,
    firstUser.slice(0, 200),
    Math.floor(updated / 1000),
    updated,
  );
  for (let i = 0; i < rollout.children.length; i++) {
    const child = rollout.children[i]!;
    db.query(
      `INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
       VALUES (?, ?, 'closed')`,
    ).run(rollout.sessionId, child.sessionId);
    indexThread(db, ir.children[i]!.session, child, "subagent");
  }
}

function firstUserText(ir: IRSession): string {
  for (const m of ir.messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim() !== "") return p.text;
    }
  }
  return "";
}

function lastModel(ir: IRSession): string | undefined {
  for (let i = ir.messages.length - 1; i >= 0; i--) {
    const id = ir.messages[i]!.model?.id;
    if (id !== undefined) return id;
  }
  return undefined;
}

function totalTokens(ir: IRSession): number {
  let n = 0;
  for (const m of ir.messages) {
    n += (m.usage?.inputTokens ?? 0) + (m.usage?.outputTokens ?? 0);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Reader
//
// COMPAT rule 11: Codex rollouts are interpreted, not concatenated — the last
// `compacted` record supersedes everything before it, `thread_rolled_back`
// events discard trailing turns, tool calls ride two envelopes, and the first
// session_meta is the identity while later ones are config updates.
// ---------------------------------------------------------------------------

export async function listCodexSessions(
  codexHome: string,
): Promise<SessionRef[]> {
  const refs: SessionRef[] = [];
  const dbPath = join(codexHome, "state_5.sqlite");
  if (await Bun.file(dbPath).exists()) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const hasThreads = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
        )
        .get();
      if (hasThreads !== null) {
        const rows = db
          .query<
            {
              id: string;
              rollout_path: string;
              cwd: string | null;
              updated_at: number | null;
              updated_at_ms: number | null;
            },
            []
          >(
            `SELECT id, rollout_path, cwd, updated_at, updated_at_ms FROM threads
             WHERE archived = 0
               AND (thread_source IS NULL OR thread_source != 'subagent')`,
          )
          .all();
        for (const row of rows) {
          if (!(await Bun.file(row.rollout_path).exists())) continue;
          refs.push({
            harness: "codex",
            id: row.id,
            locator: row.rollout_path,
            cwd: row.cwd ?? undefined,
            updatedAt:
              row.updated_at_ms ??
              (row.updated_at !== null ? row.updated_at * 1000 : undefined),
          });
        }
        return refs;
      }
    } finally {
      db.close();
    }
  }
  // no index: walk the date dirs and read each header line
  for (const meta of await scanRolloutHeads(codexHome)) {
    if (meta.parentThreadId !== undefined) continue;
    refs.push({
      harness: "codex",
      id: meta.id,
      locator: meta.path,
      cwd: meta.cwd,
      updatedAt: meta.mtime,
    });
  }
  return refs;
}

export async function readCodexSession(locator: string): Promise<ReadResult> {
  return readRollout(locator, new Set());
}

async function readRollout(
  locator: string,
  visited: Set<string>,
): Promise<ReadResult> {
  visited.add(locator);
  const text = await Bun.file(locator).text();
  const issues: ReadIssue[] = [];
  const session = buildFromRollout(text, locator, issues);
  const home = homeFromLocator(locator);
  if (home !== undefined) {
    await attachChildren(session, home, visited, issues);
  }
  return { session, issues };
}

interface RolloutRec {
  ts: number;
  type: string;
  payload: Record<string, unknown>;
  line: number;
}

function buildFromRollout(
  text: string,
  locator: string,
  issues: ReadIssue[],
): IRSession {
  const lines = text.split("\n");
  const records: RolloutRec[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    try {
      const raw = JSON.parse(line);
      records.push({
        ts: typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : 0,
        type: String(raw.type ?? ""),
        payload: (raw.payload ?? {}) as Record<string, unknown>,
        line: i + 1,
      });
    } catch (err) {
      const kind = i === lines.length - 1 ? "truncated-tail" : "bad-json";
      issues.push({ line: i + 1, kind, detail: String(err) });
    }
  }

  const session: IRSession = {
    id: newId(),
    source: { harness: "codex", id: "", locator },
    cwd: "",
    messages: [],
    children: [],
    extensions: [],
  };

  // identity = first session_meta anywhere (even in a superseded segment)
  const versions = new Set<string>();
  const firstMeta = records.find((r) => r.type === "session_meta");
  if (firstMeta !== undefined) {
    const p = firstMeta.payload;
    if (typeof p.id === "string") session.source.id = p.id;
    if (typeof p.cwd === "string") session.cwd = p.cwd;
    session.createdAt = firstMeta.ts || undefined;
  }
  for (const r of records) {
    if (r.type === "session_meta" && typeof r.payload.cli_version === "string") {
      versions.add(r.payload.cli_version);
    }
  }
  if (versions.size > 0) session.source.versions = [...versions];

  const state: ReadState = {
    session,
    issues,
    currentAssistant: null,
    currentModel: undefined,
    provider:
      typeof firstMeta?.payload.model_provider === "string"
        ? firstMeta.payload.model_provider
        : "openai",
    callNames: new Map(),
    turnStarts: [],
    sawTaskEvents: false,
  };

  // the LAST compacted record supersedes everything before it
  const lastCompact = records.findLastIndex((r) => r.type === "compacted");
  let effective = records;
  if (lastCompact >= 0) {
    const c = records[lastCompact]!;
    // archive the identity meta if it sits in the superseded segment
    if (firstMeta !== undefined && records.indexOf(firstMeta) < lastCompact) {
      pushSessionExtension(state, "session_meta", firstMeta.payload);
    }
    session.messages.push({
      id: newId(),
      role: "user",
      parts: [
        {
          type: "compaction",
          summary:
            typeof c.payload.message === "string" ? c.payload.message : "",
          meta: pickWindowMeta(c.payload),
        },
      ],
      timestamp: c.ts || undefined,
    });
    const replacement = Array.isArray(c.payload.replacement_history)
      ? (c.payload.replacement_history as Record<string, unknown>[])
      : [];
    for (const item of replacement) ingestItem(state, item, c.ts, c.line);
    effective = records.slice(lastCompact + 1);
  }

  let lastTs = 0;
  for (const r of effective) {
    if (r.ts > lastTs) lastTs = r.ts;
    switch (r.type) {
      case "session_meta":
        pushSessionExtension(state, "session_meta", r.payload);
        break;
      case "turn_context":
        if (typeof r.payload.model === "string") {
          state.currentModel = r.payload.model;
        }
        pushSessionExtension(state, "turn_context", r.payload);
        break;
      case "response_item":
        ingestItem(state, r.payload, r.ts, r.line);
        break;
      case "event_msg":
        ingestEvent(state, r.payload, r.line);
        break;
      case "compacted":
        break; // only reachable for records before lastCompact (never here)
      case "world_state":
        pushSessionExtension(state, "record:world_state", r.payload);
        break;
      default:
        pushSessionExtension(state, `record:${r.type}`, r.payload);
        issues.push({ line: r.line, kind: "unknown-record", detail: r.type });
    }
  }
  if (lastTs > 0) session.updatedAt = lastTs;

  // rollbacks may have truncated messages below archived positions
  for (const ext of session.extensions) {
    if (ext.position > session.messages.length) {
      ext.position = session.messages.length;
    }
  }
  return session;
}

interface ReadState {
  session: IRSession;
  issues: ReadIssue[];
  currentAssistant: IRMessage | null;
  currentModel: string | undefined;
  provider: string;
  callNames: Map<string, string>;
  turnStarts: number[];
  sawTaskEvents: boolean;
}

function pushSessionExtension(
  state: ReadState,
  extType: string,
  payload: unknown,
): void {
  state.session.extensions.push({
    harness: "codex",
    extType,
    position: state.session.messages.length,
    payload,
  });
}

/** synthetic context injections riding user-role messages */
const SYNTHETIC_USER = /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions|<ENVIRONMENT_CONTEXT>)/;

function ingestItem(
  state: ReadState,
  p: Record<string, unknown>,
  ts: number,
  line: number,
): void {
  switch (p.type) {
    case "message": {
      const content = Array.isArray(p.content)
        ? (p.content as Record<string, unknown>[])
        : [];
      const texts = content
        .filter((b) => typeof b.text === "string")
        .map((b) => String(b.text));
      if (p.role === "developer") {
        carrierMessage(state, "user", ts).parts.push({
          type: "extension",
          harness: "codex",
          extType: "item:developer_message",
          payload: p,
        });
        return;
      }
      if (p.role === "user") {
        if (texts.length > 0 && texts.every((t) => SYNTHETIC_USER.test(t))) {
          carrierMessage(state, "user", ts).parts.push({
            type: "extension",
            harness: "codex",
            extType: "item:synthetic_context",
            payload: p,
          });
          return;
        }
        state.currentAssistant = null;
        const message: IRMessage = {
          id: newId(),
          role: "user",
          parts: texts.map((t): IRPart => ({ type: "text", text: t })),
          timestamp: ts || undefined,
        };
        if (!state.sawTaskEvents) {
          state.turnStarts.push(state.session.messages.length);
        }
        state.session.messages.push(message);
        return;
      }
      if (p.role === "assistant") {
        const message = ensureAssistant(state, ts);
        for (const t of texts) {
          message.parts.push({
            type: "text",
            text: t,
            ...(typeof p.phase === "string" && { meta: { phase: p.phase } }),
          });
        }
        return;
      }
      pushSessionExtension(state, `item:message:${String(p.role)}`, p);
      state.issues.push({
        line,
        kind: "unknown-item-role",
        detail: String(p.role),
      });
      return;
    }
    case "reasoning": {
      const summary = Array.isArray(p.summary)
        ? (p.summary as Record<string, unknown>[])
            .filter((s) => typeof s.text === "string")
            .map((s) => String(s.text))
            .join("\n")
        : "";
      ensureAssistant(state, ts).parts.push({
        type: "thinking",
        text: summary,
        ...(p.encrypted_content !== undefined &&
          p.encrypted_content !== null && {
            signature: { provider: "openai", data: p.encrypted_content },
          }),
      });
      return;
    }
    case "function_call": {
      let input: unknown = p.arguments;
      if (typeof p.arguments === "string") {
        try {
          input = JSON.parse(p.arguments);
        } catch {
          // leave as the raw string the model actually produced
        }
      }
      const callId = String(p.call_id ?? "");
      state.callNames.set(callId, String(p.name ?? ""));
      ensureAssistant(state, ts).parts.push({
        type: "toolCall",
        callId,
        name: String(p.name ?? ""),
        input,
      });
      return;
    }
    case "custom_tool_call": {
      const callId = String(p.call_id ?? "");
      state.callNames.set(callId, String(p.name ?? ""));
      ensureAssistant(state, ts).parts.push({
        type: "toolCall",
        callId,
        name: String(p.name ?? ""),
        input: p.input,
        meta: { envelope: "custom_tool_call" },
      });
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = String(p.call_id ?? "");
      const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
      const part: IRToolResultPart = {
        type: "toolResult",
        callId,
        name: state.callNames.get(callId),
        text: output,
        isError: false,
      };
      const exec = parseExecHeader(output);
      if (exec !== undefined) {
        part.structured = exec;
        if (exec.exitCode !== 0) part.isError = true;
      }
      ensureAssistant(state, ts).parts.push(part);
      return;
    }
    case "compaction":
      // seen inside replacement_history of doubly-compacted sessions:
      // {type:"compaction", encrypted_content} — an encrypted summary of the
      // previous window. Ciphertext is provider-bound; preserved verbatim.
      carrierMessage(state, "user", ts).parts.push({
        type: "compaction",
        summary: "",
        ...(p.encrypted_content !== undefined && {
          meta: { encrypted_content: p.encrypted_content },
        }),
      });
      return;
    case "web_search_call":
    case "tool_search_call":
    case "tool_search_output":
    case "image_generation_call":
    case "agent_message":
      ensureAssistant(state, ts).parts.push({
        type: "extension",
        harness: "codex",
        extType: `item:${String(p.type)}`,
        payload: p,
      });
      return;
    default:
      ensureAssistant(state, ts).parts.push({
        type: "extension",
        harness: "codex",
        extType: `item:${String(p.type)}`,
        payload: p,
      });
      state.issues.push({ line, kind: "unknown-item", detail: String(p.type) });
  }
}

function ingestEvent(
  state: ReadState,
  p: Record<string, unknown>,
  line: number,
): void {
  switch (p.type) {
    case "token_count": {
      const info = p.info as Record<string, unknown> | undefined | null;
      const last = info?.last_token_usage as
        | Record<string, unknown>
        | undefined
        | null;
      const target =
        state.currentAssistant ?? lastAssistant(state.session.messages);
      if (last && target !== undefined && target !== null) {
        const num = (v: unknown) => (typeof v === "number" ? v : 0);
        const usage = target.usage ?? {};
        target.usage = {
          inputTokens: (usage.inputTokens ?? 0) + num(last.input_tokens),
          outputTokens: (usage.outputTokens ?? 0) + num(last.output_tokens),
          reasoningTokens:
            (usage.reasoningTokens ?? 0) + num(last.reasoning_output_tokens),
          cacheReadTokens:
            (usage.cacheReadTokens ?? 0) + num(last.cached_input_tokens),
        };
      }
      return;
    }
    case "task_started":
      state.sawTaskEvents = true;
      state.currentAssistant = null;
      state.turnStarts.push(state.session.messages.length);
      return;
    case "task_complete":
      state.currentAssistant = null;
      return;
    case "user_message":
      return; // echo of the user response_item — reconstructable
    case "thread_rolled_back": {
      pushSessionExtension(state, "event:thread_rolled_back", p);
      let n = typeof p.num_turns === "number" ? p.num_turns : 1;
      while (n > 0 && state.turnStarts.length > 0) {
        const cut = state.turnStarts.pop()!;
        state.session.messages.length = Math.min(
          cut,
          state.session.messages.length,
        );
        n--;
      }
      state.currentAssistant = null;
      return;
    }
    default:
      pushSessionExtension(state, `event:${String(p.type)}`, p);
  }
}

function ensureAssistant(state: ReadState, ts: number): IRMessage {
  if (state.currentAssistant === null) {
    state.currentAssistant = {
      id: newId(),
      role: "assistant",
      parts: [],
      timestamp: ts || undefined,
      ...(state.currentModel !== undefined && {
        model: { provider: state.provider, id: state.currentModel },
      }),
    };
    state.session.messages.push(state.currentAssistant);
  }
  return state.currentAssistant;
}

function carrierMessage(
  state: ReadState,
  role: "user" | "assistant",
  ts: number,
): IRMessage {
  // positional carrier for extension parts that arrive outside any message
  const message: IRMessage = {
    id: newId(),
    role,
    parts: [],
    timestamp: ts || undefined,
  };
  state.session.messages.push(message);
  return message;
}

function lastAssistant(messages: IRMessage[]): IRMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i];
  }
  return undefined;
}

/** exec_command/apply_patch outputs embed a text-protocol header */
function parseExecHeader(output: string): { exitCode: number } | undefined {
  const head = output.slice(0, 400);
  const match =
    head.match(/^Process exited with code (\d+)$/m) ??
    head.match(/^Exit code: (\d+)$/m);
  if (match === null) return undefined;
  return { exitCode: Number(match[1]) };
}

function pickWindowMeta(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = ["window_id", "window_number", "first_window_id", "previous_window_id"];
  const meta: Record<string, unknown> = {};
  for (const k of keys) if (payload[k] !== undefined) meta[k] = payload[k];
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function homeFromLocator(locator: string): string | undefined {
  const idx = locator.lastIndexOf("/sessions/");
  return idx > 0 ? locator.slice(0, idx) : undefined;
}

interface RolloutHead {
  path: string;
  id: string;
  cwd: string | undefined;
  parentThreadId: string | undefined;
  mtime: number;
}

async function scanRolloutHeads(codexHome: string): Promise<RolloutHead[]> {
  const heads: RolloutHead[] = [];
  try {
    const glob = new Bun.Glob("sessions/**/rollout-*.jsonl");
    for await (const rel of glob.scan({ cwd: codexHome, onlyFiles: true })) {
      const full = join(codexHome, rel);
      try {
        const head = await Bun.file(full).slice(0, 4 << 20).text();
        const meta = JSON.parse(head.split("\n", 1)[0]!);
        if (meta?.type !== "session_meta") continue;
        const p = meta.payload ?? {};
        heads.push({
          path: full,
          id: typeof p.id === "string" ? p.id : "",
          cwd: typeof p.cwd === "string" ? p.cwd : undefined,
          parentThreadId:
            typeof p.parent_thread_id === "string" ? p.parent_thread_id : undefined,
          mtime: await stat(full)
            .then((s) => s.mtimeMs)
            .catch(() => 0),
        });
      } catch {
        // unreadable head — skip
      }
    }
  } catch {
    // no sessions dir
  }
  return heads;
}

async function attachChildren(
  session: IRSession,
  codexHome: string,
  visited: Set<string>,
  issues: ReadIssue[],
): Promise<void> {
  const dbPath = join(codexHome, "state_5.sqlite");
  const children: { path: string; agentType?: string; description?: string }[] = [];
  let indexed = false;
  if (await Bun.file(dbPath).exists()) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const hasTables =
        db
          .query(
            "SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'thread_spawn_edges')",
          )
          .get() as { n: number } | null;
      if (hasTables !== null && hasTables.n === 2) {
        indexed = true;
        // title comes along for free
        const own = db
          .query<{ title: string | null }, [string]>(
            "SELECT title FROM threads WHERE id = ?",
          )
          .get(session.source.id);
        if (own?.title != null && own.title !== "" && session.title === undefined) {
          session.title = own.title;
        }
        const rows = db
          .query<
            {
              rollout_path: string | null;
              agent_role: string | null;
              agent_nickname: string | null;
            },
            [string]
          >(
            `SELECT t.rollout_path, t.agent_role, t.agent_nickname
             FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id
             WHERE e.parent_thread_id = ?`,
          )
          .all(session.source.id);
        for (const row of rows) {
          if (row.rollout_path === null) continue;
          children.push({
            path: row.rollout_path,
            agentType: row.agent_role ?? undefined,
            description: row.agent_nickname ?? undefined,
          });
        }
      }
    } finally {
      db.close();
    }
  }
  if (!indexed) {
    // no index (e.g. a fresh --target-home): match parent_thread_id by header
    for (const head of await scanRolloutHeads(codexHome)) {
      if (head.parentThreadId === session.source.id) {
        children.push({ path: head.path });
      }
    }
  }
  for (const child of children) {
    if (visited.has(child.path)) continue;
    if (!(await Bun.file(child.path).exists())) continue;
    const result = await readRollout(child.path, visited);
    issues.push(...result.issues);
    const ref: IRChildSession = { session: result.session };
    if (child.agentType !== undefined) ref.agentType = child.agentType;
    if (child.description !== undefined) ref.description = child.description;
    session.children.push(ref);
  }
}
