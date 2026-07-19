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
import type { IRMessage, IRSession, IRToolResultPart } from "../ir.ts";
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
