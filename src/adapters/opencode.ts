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
import type {
  IRMessage,
  IRPart,
  IRSession,
  IRToolResultPart,
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
    if (ms === this.lastMs) this.counter++;
    else {
      this.lastMs = ms;
      this.counter = 1;
    }
    const shifted = Math.max(ms - MSG_TIME_OFFSET, 1);
    const time = (BigInt(shifted) << 12n) | BigInt(this.counter);
    return `${prefix}_${time.toString(16).padStart(12, "0")}${randomBase62(14)}`;
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
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project', 'session', 'message', 'part')",
      )
      .all();
    if (tables.length !== 4) {
      throw new Error(text.opencodeTablesMissing(dbPath));
    }
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
  let prevMsgId: string | null = null;
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

      const msgId = ids.next("msg", ts);
      lastAssistantId = msgId;
      const parts = assistantParts(message, results, consumed, childIdByCall, ts, msgId);
      const hasTool = parts.some((p) => (p as { type?: string }).type === "tool");
      const data = {
        parentID: prevMsgId,
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
      insertMessage.run(msgId, sesId, ts, ts, JSON.stringify(data));
      for (const part of parts) {
        insertPart.run(
          ids.next("prt", ts),
          msgId,
          sesId,
          ts,
          ts,
          JSON.stringify(part),
        );
      }
      prevMsgId = msgId;
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
      insertMessage.run(msgId, sesId, ts, ts, JSON.stringify(data));
      for (const part of parts) {
        insertPart.run(
          ids.next("prt", ts),
          msgId,
          sesId,
          ts,
          ts,
          JSON.stringify(part),
        );
      }
      prevMsgId = msgId;
    }
  }

  // unpaired results (fork gaps): a tool part on the last assistant message
  for (const [callId, result] of results) {
    if (consumed.has(result) || lastAssistantId === null) continue;
    insertPart.run(
      ids.next("prt", updated),
      lastAssistantId,
      sesId,
      updated,
      updated,
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
