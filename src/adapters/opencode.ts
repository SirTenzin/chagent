/**
 * OpenCode adapter — writer.
 *
 * Target: the sqlite database (`opencode.db`) — the authoritative store; the
 * legacy JSON tree froze in early 2026. Rows: `project` → `session` →
 * `message` → `part`, with conversation content as JSON blobs in `data`
 * columns (id/session_id/message_id live in columns, NOT in the blob).
 *
 * Two formats verified against the real db on 2026-07-19:
 *
 * - projectID is the git repo's ROOT COMMIT sha1 (`git rev-list
 *   --max-parents=0 HEAD`), not a path hash. Non-git directories bucket into
 *   the reserved `global` project (worktree `/`).
 * - ids are `<prefix>_<12 hex time component><14 base62 random>`:
 *   sessions descend (`(0x1A000000000 - 1 - ms) << 12 | 0xffe` — newest
 *   sorts first), messages/parts ascend (`(ms + 0x19000000000) << 12 | ctr`).
 *
 * The writer only touches the db path the caller provides — tests point it
 * at a scratch copy, never the real one.
 */

import { Database } from "bun:sqlite";
import { text } from "../text.ts";
import {
  newId,
  type IRChildSession,
  type IRMessage,
  type IRPart,
  type IRSession,
  type IRToolResultPart,
  type IRUsage,
  type ReadIssue,
  type ReadResult,
  type SessionRef,
} from "../ir.ts";
import { randomBase62 } from "../util.ts";

export interface OpenCodeWriteResult {
  dbPath: string;
  sessionId: string;
  /** id form shown to the user (matches the one in resumeHint) */
  displayId: string;
  resumeHint: string;
}

const SES_TIME_BASE = 0x1a000000000 - 1; // sessions: descending time component
const MSG_TIME_OFFSET = 0x19000000000; // messages/parts: ascending, offset-subtracted

export function sessionId(ms: number): string {
  const time = ((BigInt(SES_TIME_BASE) - BigInt(ms)) << 12n) | 0xffen;
  return `ses_${time.toString(16).padStart(12, "0")}${randomBase62(14)}`;
}

class AscendingId {
  private lastMs = 0;
  private counter = 0;
  next(prefix: string, ms: number): string {
    // ids must be monotonic in emission order: source timestamps can run
    // backwards a few ms (observed in CC records), and opencode orders by id
    if (ms <= this.lastMs) {
      ms = this.lastMs;
      this.counter++;
    } else {
      this.lastMs = ms;
      this.counter = 1;
    }
    const shifted = Math.max(ms - MSG_TIME_OFFSET, 1);
    const time = (BigInt(shifted) << 12n) | BigInt(this.counter);
    return `${prefix}_${time.toString(16).padStart(12, "0")}${randomBase62(14)}`;
  }
  /** the clamped ms of the last id — used for row time columns so stored
   * ordering (time_created, id) stays self-consistent */
  get ms(): number {
    return this.lastMs;
  }
}

const SLUG_A = "calm silent shiny kind brave quiet swift misty amber cedar".split(" ");
const SLUG_B = "nebula lagoon knight cabin squid harbor meadow signal ridge".split(" ");
function randomSlug(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]!;
  return `${pick(SLUG_A)}-${pick(SLUG_B)}`;
}

export async function writeOpenCodeSession(
  ir: IRSession,
  dbPath: string,
): Promise<OpenCodeWriteResult> {
  // the db IS opencode's store — chagent NEVER creates it or runs DDL;
  // opencode's own migrations own that schema
  if (!(await Bun.file(dbPath).exists())) {
    throw new Error(text.opencodeDbMissing(dbPath));
  }
  const db = new Database(dbPath, { readwrite: true });
  try {
    assertTables(db, dbPath);
    db.exec("BEGIN");
    const projectId = await resolveProject(db, ir.cwd);
    const id = writeSession(db, ir, projectId, null);
    db.exec("COMMIT");
    // opencode run -s takes a session id; --help documents no prefix form,
    // so the hint carries the full id
    return {
      dbPath,
      sessionId: id,
      displayId: id,
      resumeHint: text.resumeOpencode(id),
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    db.close();
  }
}

function assertTables(db: Database, dbPath: string): void {
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project', 'session', 'message', 'part')",
    )
    .all();
  if (tables.length !== 4) {
    throw new Error(text.opencodeTablesMissing(dbPath));
  }
}

/**
 * projectID = root commit sha of the cwd's git repo. Reuse an existing row
 * when one matches; non-git directories use the reserved `global` project.
 */
async function resolveProject(db: Database, cwd: string): Promise<string> {
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM project WHERE worktree = ?")
    .get(cwd);
  if (existing !== null) return existing.id;

  const git = Bun.spawnSync(
    ["git", "-C", cwd, "rev-list", "--max-parents=0", "HEAD"],
  );
  const root = git.success
    ? git.stdout.toString().trim().split("\n")[0]
    : undefined;
  const now = Date.now();
  if (root !== undefined && /^[0-9a-f]{40}$/.test(root)) {
    db.query(
      `INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes)
       VALUES (?, ?, 'git', ?, ?, '[]')
       ON CONFLICT(id) DO NOTHING`,
    ).run(root, cwd, now, now);
    return root;
  }
  db.query(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
     VALUES ('global', '/', ?, ?, '[]')
     ON CONFLICT(id) DO NOTHING`,
  ).run(now, now);
  return "global";
}

function writeSession(
  db: Database,
  ir: IRSession,
  projectId: string,
  parentId: string | null,
): string {
  const created = ir.createdAt ?? Date.now();
  const updated = ir.updatedAt ?? created;
  const sesId = sessionId(created);
  const ids = new AscendingId();
  const version =
    db
      .query<{ version: string }, []>(
        "SELECT version FROM session ORDER BY time_created DESC LIMIT 1",
      )
      .get()?.version ?? "1.17.18";

  const insertMessage = db.query(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertPart = db.query(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // children first: parent tool parts link to child session ids
  const childIdByCall = new Map<string, string>();
  for (const child of ir.children) {
    const childId = writeSession(db, child.session, projectId, sesId);
    if (child.linkedCallId !== undefined) {
      childIdByCall.set(child.linkedCallId, childId);
    }
  }

  const results = collectResults(ir);
  const consumed = new Set<IRToolResultPart>();
  const totals = {
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let lastModel: { providerID: string; modelID: string } = {
    providerID: "anthropic",
    modelID: "unknown",
  };
  // OpenCode groups every assistant step in a turn under the user message
  // that started it. The UI rejects an assistant whose parentID resolves to
  // another assistant (and drops the whole loaded page), so never chain
  // assistant → assistant here.
  let currentUserId: string | null = null;
  let lastAssistantId: string | null = null;

  for (const message of ir.messages) {
    const ts = message.timestamp ?? created;
    if (message.role === "assistant") {
      if (message.model?.id !== undefined) {
        lastModel = {
          providerID: message.model.provider ?? "unknown",
          modelID: message.model.id,
        };
      }
      const usage = message.usage;
      totals.input += usage?.inputTokens ?? 0;
      totals.output += usage?.outputTokens ?? 0;
      totals.cacheRead += usage?.cacheReadTokens ?? 0;
      totals.cacheWrite += usage?.cacheWriteTokens ?? 0;
      totals.cost += usage?.costUsd ?? 0;

      // Subagent transcripts can begin with an assistant continuation because
      // the parent context is inherited out-of-band. OpenCode nevertheless
      // requires every assistant parent to be a user row. Add an invisible
      // (part-less) user anchor rather than inventing visible transcript text.
      if (currentUserId === null) {
        const anchorId = ids.next("msg", ts);
        insertMessage.run(
          anchorId,
          sesId,
          ids.ms,
          ids.ms,
          JSON.stringify({
            role: "user",
            time: { created: ts },
            agent: "build",
            model: {
              providerID: lastModel.providerID,
              modelID: lastModel.modelID,
            },
            synthetic: true,
          }),
        );
        currentUserId = anchorId;
      }

      const msgId = ids.next("msg", ts);
      lastAssistantId = msgId;
      const parts = assistantParts(message, results, consumed, childIdByCall, ts, msgId);
      const hasTool = parts.some((p) => (p as { type?: string }).type === "tool");
      const data = {
        parentID: currentUserId,
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: ir.cwd, root: ir.cwd },
        cost: usage?.costUsd ?? 0,
        tokens: {
          total: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          reasoning: usage?.reasoningTokens ?? 0,
          cache: {
            read: usage?.cacheReadTokens ?? 0,
            write: usage?.cacheWriteTokens ?? 0,
          },
        },
        modelID: lastModel.modelID,
        providerID: lastModel.providerID,
        time: { created: ts, completed: ts },
        finish: hasTool ? "tool-calls" : "stop",
        ...(message.parts.some((p) => p.type === "compaction") && {
          summary: true,
        }),
      };
      insertMessage.run(msgId, sesId, ids.ms, ids.ms, JSON.stringify(data));
      for (const part of parts) {
        const partId = ids.next("prt", ts);
        insertPart.run(partId, msgId, sesId, ids.ms, ids.ms, JSON.stringify(part));
      }
    } else {
      // results are folded into assistant tool parts; a user message that
      // carried only results produces no OpenCode message at all
      if (!message.parts.some((p) => p.type !== "toolResult")) continue;
      const msgId = ids.next("msg", ts);
      const parts = userParts(message, ts, msgId);
      if (parts.length === 0) continue;
      const data = {
        role: "user",
        time: { created: ts },
        agent: "build",
        model: { providerID: lastModel.providerID, modelID: lastModel.modelID },
      };
      insertMessage.run(msgId, sesId, ids.ms, ids.ms, JSON.stringify(data));
      for (const part of parts) {
        const partId = ids.next("prt", ts);
        insertPart.run(partId, msgId, sesId, ids.ms, ids.ms, JSON.stringify(part));
      }
      currentUserId = msgId;
    }
  }

  // unpaired results (fork gaps): a tool part on the last assistant message
  for (const [callId, result] of results) {
    if (consumed.has(result) || lastAssistantId === null) continue;
    const partId = ids.next("prt", updated);
    insertPart.run(
      partId,
      lastAssistantId,
      sesId,
      ids.ms,
      ids.ms,
      JSON.stringify(toolPart(callId, result.name ?? "unknown", undefined, result, undefined)),
    );
  }

  db.query(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title,
       version, time_created, time_updated, cost, tokens_input, tokens_output,
       tokens_reasoning, tokens_cache_read, tokens_cache_write, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sesId,
    projectId,
    parentId,
    randomSlug(),
    ir.cwd,
    ir.title ?? "imported by chagent",
    version,
    created,
    updated,
    totals.cost,
    totals.input,
    totals.output,
    totals.reasoning,
    totals.cacheRead,
    totals.cacheWrite,
    ir.extensions.length > 0
      ? JSON.stringify({ chagent: { source: ir.source, extensions: ir.extensions } })
      : null,
  );
  return sesId;
}

function collectResults(ir: IRSession): Map<string, IRToolResultPart> {
  const map = new Map<string, IRToolResultPart>();
  for (const message of ir.messages) {
    for (const part of message.parts) {
      if (part.type === "toolResult" && !map.has(part.callId)) {
        map.set(part.callId, part);
      }
    }
  }
  return map;
}

function assistantParts(
  message: IRMessage,
  results: Map<string, IRToolResultPart>,
  consumed: Set<IRToolResultPart>,
  childIdByCall: Map<string, string>,
  ts: number,
  msgId: string,
): unknown[] {
  const parts: unknown[] = [{ type: "step-start" }];
  let sawTool = false;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "thinking":
        parts.push({
          type: "reasoning",
          text: part.text,
          time: { start: ts, end: ts },
          ...(part.signature !== undefined && {
            metadata: {
              [part.signature.provider]: { signature: part.signature.data },
            },
          }),
        });
        break;
      case "toolCall": {
        sawTool = true;
        const result = results.get(part.callId);
        if (result !== undefined) consumed.add(result);
        parts.push(
          toolPart(part.callId, part.name, part.input, result, childIdByCall.get(part.callId)),
        );
        break;
      }
      case "compaction":
        // everything from the containing message onward is the kept tail
        parts.push({
          type: "compaction",
          auto: false,
          overflow: false,
          tail_start_id: msgId,
        });
        if (part.summary !== undefined && part.summary !== "") {
          parts.push({ type: "text", text: part.summary });
        }
        break;
      default:
        break; // lane 2: origin-harness bookkeeping stays out
    }
  }
  const usage = message.usage;
  parts.push({
    type: "step-finish",
    reason: sawTool ? "tool-calls" : "stop",
    cost: usage?.costUsd ?? 0,
    tokens: {
      total: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      reasoning: usage?.reasoningTokens ?? 0,
      cache: {
        read: usage?.cacheReadTokens ?? 0,
        write: usage?.cacheWriteTokens ?? 0,
      },
    },
  });
  return parts;
}

function toolPart(
  callId: string,
  name: string,
  input: unknown,
  result: IRToolResultPart | undefined,
  childSessionId: string | undefined,
): unknown {
  const structured =
    result !== undefined &&
    typeof result.structured === "object" &&
    result.structured !== null &&
    !Array.isArray(result.structured)
      ? (result.structured as Record<string, unknown>)
      : undefined;
  return {
    type: "tool",
    tool: name,
    callID: callId,
    state: {
      status: result?.isError === true ? "error" : "completed",
      input: input ?? {},
      ...(result?.isError === true
        ? { error: result.text }
        : { output: result?.text ?? "" }),
      ...(childSessionId !== undefined
        ? { metadata: { ...structured, sessionId: childSessionId } }
        : structured !== undefined && { metadata: structured }),
    },
  };
}

function userParts(message: IRMessage, ts: number, msgId: string): unknown[] {
  const parts: unknown[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image":
        parts.push({
          type: "file",
          mime: part.mediaType,
          filename: "clipboard",
          url: `data:${part.mediaType};base64,${part.data}`,
          source: {
            type: "file",
            text: { value: "[Image]", start: 0, end: 0 },
          },
        });
        break;
      case "attachment":
        // model-visible file content, lane 3: synthetic text at position
        parts.push({
          type: "text",
          text:
            part.path !== undefined
              ? `@${part.path}\n${part.text ?? ""}`
              : part.text ?? "",
          synthetic: true,
        });
        break;
      case "compaction":
        parts.push({
          type: "compaction",
          auto: false,
          overflow: false,
          tail_start_id: msgId,
        });
        if (part.summary !== undefined && part.summary !== "") {
          parts.push({ type: "text", text: part.summary, synthetic: true });
        }
        break;
      default:
        break; // toolResult handled via pairing; extensions lane 2
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

export async function listOpenCodeSessions(
  dbPath: string,
): Promise<SessionRef[]> {
  if (!(await Bun.file(dbPath).exists())) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    assertTables(db, dbPath);
    const rows = db
      .query<{ id: string; directory: string; time_updated: number }, []>(
        `SELECT id, directory, time_updated FROM session
         WHERE parent_id IS NULL ORDER BY time_updated DESC`,
      )
      .all();
    return rows.map((r) => ({
      harness: "opencode",
      id: r.id,
      locator: `${dbPath}::${r.id}`,
      cwd: r.directory,
      updatedAt: r.time_updated,
    }));
  } finally {
    db.close();
  }
}

export async function readOpenCodeSession(
  locator: string,
): Promise<ReadResult> {
  const sep = locator.lastIndexOf("::");
  if (sep === -1) {
    throw new Error(`bad opencode locator (expected <dbPath>::<ses_id>): ${locator}`);
  }
  const dbPath = locator.slice(0, sep);
  const rootId = locator.slice(sep + 2);
  const db = new Database(dbPath, { readonly: true });
  try {
    assertTables(db, dbPath);
    const issues: ReadIssue[] = [];
    const session = readTree(db, dbPath, rootId, issues);
    return { session, issues };
  } finally {
    db.close();
  }
}

function readTree(
  db: Database,
  dbPath: string,
  sesId: string,
  issues: ReadIssue[],
): IRSession {
  const row = db
    .query<Row, [string]>("SELECT * FROM session WHERE id = ?")
    .get(sesId);
  if (row === null) throw new Error(`no opencode session ${sesId} in ${dbPath}`);

  const session: IRSession = {
    id: newId(),
    source: {
      harness: "opencode",
      id: sesId,
      locator: `${dbPath}::${sesId}`,
      ...(typeof row.version === "string" && { versions: [row.version] }),
    },
    cwd: typeof row.directory === "string" ? row.directory : "",
    ...(typeof row.title === "string" && { title: row.title }),
    ...(typeof row.time_created === "number" && { createdAt: row.time_created }),
    ...(typeof row.time_updated === "number" && { updatedAt: row.time_updated }),
    messages: [],
    children: [],
    extensions: [],
  };

  // session.metadata: our chagent sidecar restores verbatim; anything else
  // is opencode bookkeeping, kept as a session extension
  if (typeof row.metadata === "string" && row.metadata !== "") {
    try {
      const meta = JSON.parse(row.metadata) as Row;
      const chagent = meta.chagent as Row | undefined;
      if (chagent !== undefined && Array.isArray(chagent.extensions)) {
        session.extensions.push(...(chagent.extensions as IRSession["extensions"]));
        if (chagent.source !== undefined) {
          session.extensions.push({
            harness: "opencode",
            extType: "chagent:origin",
            position: 0,
            payload: chagent.source,
          });
        }
        delete meta.chagent;
      }
      if (Object.keys(meta).length > 0) {
        session.extensions.push({
          harness: "opencode",
          extType: "session-metadata",
          position: 0,
          payload: meta,
        });
      }
    } catch (err) {
      issues.push({ line: 0, kind: "bad-session-metadata", detail: String(err) });
    }
  }

  // parts grouped per message, both ordered by ascending id
  const partsByMsg = new Map<string, Row[]>();
  for (const p of db
    .query<{ message_id: string; data: string }, [string]>(
      "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id",
    )
    .all(sesId)) {
    let data: Row;
    try {
      data = JSON.parse(p.data);
    } catch (err) {
      issues.push({ line: 0, kind: "bad-part-json", detail: String(err) });
      continue;
    }
    const bucket = partsByMsg.get(p.message_id) ?? [];
    bucket.push(data);
    partsByMsg.set(p.message_id, bucket);
  }

  /** task-tool callId -> child session id, for child linkage */
  const childCallByOcId = new Map<string, string>();

  for (const m of db
    .query<{ id: string; time_created: number; data: string }, [string]>(
      "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY id",
    )
    .all(sesId)) {
    let data: Row;
    try {
      data = JSON.parse(m.data);
    } catch (err) {
      issues.push({ line: 0, kind: "bad-message-json", detail: String(err) });
      continue;
    }
    const message = toMessage(
      data,
      partsByMsg.get(m.id) ?? [],
      m.time_created,
      childCallByOcId,
      issues,
    );
    if (message !== undefined) session.messages.push(message);
  }

  for (const child of db
    .query<{ id: string }, [string]>(
      "SELECT id FROM session WHERE parent_id = ? ORDER BY time_created",
    )
    .all(sesId)) {
    const ref: IRChildSession = {
      session: readTree(db, dbPath, child.id, issues),
    };
    const linked = childCallByOcId.get(child.id);
    if (linked !== undefined) ref.linkedCallId = linked;
    session.children.push(ref);
  }
  return session;
}

const MESSAGE_MAPPED_KEYS = new Set([
  "role",
  "time",
  "tokens",
  "cost",
  "modelID",
  "providerID",
  "model",
]);

function toMessage(
  data: Row,
  rawParts: Row[],
  fallbackTs: number,
  childCallByOcId: Map<string, string>,
  issues: ReadIssue[],
): IRMessage | undefined {
  const role = data.role;
  if (role !== "user" && role !== "assistant") {
    issues.push({ line: 0, kind: "unknown-role", detail: String(role) });
    return undefined;
  }

  const parts: IRPart[] = [];
  for (const raw of rawParts) {
    parts.push(...toParts(raw, childCallByOcId, issues));
  }

  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!MESSAGE_MAPPED_KEYS.has(k)) meta[k] = v;
  }

  const time = data.time as Row | undefined;
  const message: IRMessage = {
    id: newId(),
    role,
    parts,
    timestamp:
      typeof time?.created === "number" ? time.created : fallbackTs,
    ...(Object.keys(meta).length > 0 && { meta }),
  };

  const model = modelOf(data);
  if (model !== undefined) message.model = model;
  const usage = usageOf(data);
  if (usage !== undefined) message.usage = usage;
  return message;
}

/** both field generations: top-level modelID/providerID, or nested model{} */
function modelOf(data: Row): IRMessage["model"] {
  if (typeof data.modelID === "string") {
    return {
      ...(typeof data.providerID === "string" && { provider: data.providerID }),
      id: data.modelID,
    };
  }
  const model = data.model as Row | undefined;
  if (model === undefined) return undefined;
  const id = typeof model.modelID === "string" ? model.modelID
    : typeof model.id === "string" ? model.id : undefined;
  if (id === undefined) return undefined;
  return {
    ...(typeof model.providerID === "string" && { provider: model.providerID }),
    id,
  };
}

function usageOf(data: Row): IRUsage | undefined {
  const tokens = data.tokens as Row | undefined;
  if (tokens === undefined && typeof data.cost !== "number") return undefined;
  const cache = tokens?.cache as Row | undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const usage: IRUsage = {
    inputTokens: num(tokens?.input),
    outputTokens: num(tokens?.output),
    reasoningTokens: num(tokens?.reasoning),
    cacheReadTokens: num(cache?.read),
    cacheWriteTokens: num(cache?.write),
    costUsd: num(data.cost),
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined;
}

function toParts(
  raw: Row,
  childCallByOcId: Map<string, string>,
  issues: ReadIssue[],
): IRPart[] {
  switch (raw.type) {
    case "text": {
      const meta: Record<string, unknown> = {};
      if (raw.synthetic === true) meta.synthetic = true;
      return [
        {
          type: "text",
          text: String(raw.text ?? ""),
          ...(Object.keys(meta).length > 0 && { meta }),
        },
      ];
    }
    case "reasoning": {
      const md = (raw.metadata ?? {}) as Row;
      const provider = ["anthropic", "bedrock", "openai"].find(
        (ns) => md[ns] !== undefined,
      );
      const nsValue = provider !== undefined ? (md[provider] as Row) : undefined;
      return [
        {
          type: "thinking",
          text: String(raw.text ?? ""),
          ...(provider !== undefined &&
            nsValue !== undefined && {
              signature: {
                provider,
                // our writer wraps a bare signature as {signature}; native
                // shapes (openai {itemId, reasoningEncryptedContent}) pass
                // through whole
                data:
                  Object.keys(nsValue).length === 1 &&
                  nsValue.signature !== undefined
                    ? nsValue.signature
                    : nsValue,
              },
            }),
        },
      ];
    }
    case "tool": {
      const state = (raw.state ?? {}) as Row;
      const callId = String(raw.callID ?? "");
      const name = String(raw.tool ?? "");
      const stateMeta = state.metadata as Row | undefined;
      if (typeof stateMeta?.sessionId === "string") {
        childCallByOcId.set(stateMeta.sessionId, callId);
      }
      const status = String(state.status ?? "completed");
      const result: IRToolResultPart = {
        type: "toolResult",
        callId,
        name,
        text: String(
          status === "error" ? state.error ?? "" : state.output ?? "",
        ),
        isError: status === "error",
        ...(stateMeta !== undefined && { structured: stateMeta }),
        meta: {
          status,
          ...(state.title !== undefined && { title: state.title }),
          ...(raw.metadata !== undefined && { partMetadata: raw.metadata }),
          ...((status === "running" || status === "pending") && {
            incomplete: true,
          }),
        },
      };
      return [
        { type: "toolCall", callId, name, input: state.input ?? {} },
        result,
      ];
    }
    case "compaction":
      return [
        {
          type: "compaction",
          ...(typeof raw.auto === "boolean" && { auto: raw.auto }),
          meta: { opencode: raw },
        },
      ];
    case "file": {
      const url = String(raw.url ?? "");
      if (url.startsWith("data:")) {
        const comma = url.indexOf(",");
        return [
          {
            type: "image",
            mediaType: String(raw.mime ?? "application/octet-stream"),
            data: comma === -1 ? "" : url.slice(comma + 1),
            meta: { opencode: { ...raw, url: undefined } },
          },
        ];
      }
      const source = raw.source as Row | undefined;
      return [
        {
          type: "attachment",
          path:
            typeof source?.path === "string"
              ? source.path
              : typeof raw.filename === "string"
                ? raw.filename
                : undefined,
          mime: typeof raw.mime === "string" ? raw.mime : undefined,
          meta: { opencode: raw },
        },
      ];
    }
    default:
      // step-start/step-finish framing, agent mentions, patches, subtasks,
      // future part types: positional extensions, never dropped
      return [
        {
          type: "extension",
          harness: "opencode",
          extType: `part:${String(raw.type)}`,
          payload: raw,
        },
      ];
  }
}
