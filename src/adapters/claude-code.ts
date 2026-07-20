/**
 * Claude Code adapter — reader + writer.
 *
 * Source format: `~/.claude/projects/<dashed-cwd>/<uuid>.jsonl`, one JSONL
 * record per line. Conversation records (`user`/`assistant`/`attachment`)
 * carry an Anthropic-API-shaped `message` plus envelope fields; everything
 * else (`system`, `file-history-snapshot`, `mode`, …) is harness bookkeeping.
 * Subagent transcripts live out-of-band in `<dir>/<sessionId>/subagents/`.
 *
 * Tool palettes drift with harness versions — this reader never interprets
 * tool names, only structure.
 */

import { basename, dirname, join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { text } from "../text.ts";
import {
  newId,
  type ReadIssue,
  type ReadResult,
  type IRChildSession,
  type IRExtension,
  type IRImagePart,
  type IRMessage,
  type IRPart,
  type IRSession,
  type IRToolResultPart,
} from "../ir.ts";

const HARNESS = "claude";

export interface ClaudeWriteResult {
  filePath: string;
  sessionId: string;
  displayId: string;
  resumeHint: string;
}

/** envelope fields preserved on message.meta when present */
const ENVELOPE_KEYS = [
  "promptId",
  "promptSource",
  "userType",
  "entrypoint",
  "permissionMode",
  "gitBranch",
  "isMeta",
  "isVisibleInTranscriptOnly",
  "interruptedMessageId",
  "origin",
  "toolDenialKind",
  "imagePasteIds",
  "sourceToolAssistantUUID",
  "slug",
  "attributionAgent",
  "agentId",
  "requestId",
] as const;

type Rec = Record<string, unknown>;

export type { ReadIssue, ReadResult } from "../ir.ts";

export function claudeProjectDir(cwd: string): string {
  // observed encoding: both "/" and "." become "-"; spaces survive
  return cwd.replace(/[/.]/g, "-");
}

export async function listClaudeSessions(
  claudeHome: string,
  cwd?: string,
): Promise<string[]> {
  const root = join(claudeHome, "projects");
  const dirs = cwd
    ? [claudeProjectDir(cwd)]
    : await readdir(root).catch(() => []);
  const files: string[] = [];
  for (const dir of dirs) {
    const entries = await readdir(join(root, dir)).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(join(root, dir, entry));
    }
  }
  return files;
}

export async function readClaudeSession(
  filePath: string,
): Promise<ReadResult> {
  const text = await Bun.file(filePath).text();
  const result = parseRecords(text, filePath);
  result.session.children = await readSubagents(filePath, result);
  return result;
}

function parseRecords(
  text: string,
  locator: string,
  expectSidechain = false,
): ReadResult {
  const issues: ReadIssue[] = [];
  const session: IRSession = {
    id: newId(),
    source: { harness: HARNESS, id: basename(locator, ".jsonl"), locator },
    cwd: "",
    messages: [],
    children: [],
    extensions: [],
  };
  const versions = new Set<string>();
  /** source uuid -> IR message, for attachment parenting */
  const byUuid = new Map<string, IRMessage>();
  /** records marked isSidechain, grouped for inline-sidechain builds */
  const sidechains = new Map<string, Rec[]>();

  const lines = text.split("\n");
  const records: { rec: Rec; line: number }[] = [];
  /** dedupe: sessions re-append updated copies of earlier records (resume,
   * compaction re-emission) under the same uuid — keep the first position
   * but the last content */
  const posByUuid = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let rec: Rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      // a live session can have a partially-written last line; anything else
      // is a real problem
      const kind = i === lines.length - 1 ? "truncated-tail" : "bad-json";
      issues.push({ line: i + 1, kind, detail: String(err) });
      continue;
    }
    if (typeof rec.uuid === "string") {
      const prev = posByUuid.get(rec.uuid);
      if (prev !== undefined) {
        records[prev] = { rec, line: i + 1 };
        continue;
      }
      posByUuid.set(rec.uuid, records.length);
    }
    records.push({ rec, line: i + 1 });
  }

  for (const { rec, line } of records) {
    // subagent transcript files flag every record isSidechain — only divert
    // when a sidechain record shows up inline in a main transcript
    if (rec.isSidechain === true && !expectSidechain) {
      const key = typeof rec.agentId === "string" ? rec.agentId : "";
      const bucket = sidechains.get(key) ?? [];
      bucket.push(rec);
      sidechains.set(key, bucket);
      continue;
    }

    ingestRecord(rec, session, byUuid, versions, issues, line);
  }

  // older builds keep subagent transcripts inline, flagged isSidechain
  for (const [agentId, recs] of sidechains) {
    const child: IRSession = {
      id: newId(),
      source: {
        harness: HARNESS,
        id: agentId || `${session.source.id}:sidechain`,
        locator,
      },
      cwd: session.cwd,
      messages: [],
      children: [],
      extensions: [],
    };
    const childUuids = new Map<string, IRMessage>();
    for (const rec of recs) {
      ingestRecord(rec, child, childUuids, versions, issues, 0);
    }
    session.children.push({
      session: child,
      agentType: agentId ? undefined : "sidechain",
    });
  }

  if (versions.size > 0) session.source.versions = [...versions];
  inferToolResultNames(session);
  return { session, issues };
}

/** Claude's tool_result block carries only the call id. Recover the optional
 * IR name from the matching native tool_use so same-session conversions do not
 * discard it. Scanning all calls first also handles forked logs where a result
 * appears before its call in file order. */
function inferToolResultNames(session: IRSession): void {
  const names = new Map<string, string>();
  for (const message of session.messages) {
    for (const part of message.parts) {
      if (part.type === "toolCall") names.set(part.callId, part.name);
    }
  }
  for (const message of session.messages) {
    for (const part of message.parts) {
      if (part.type === "toolResult" && part.name === undefined) {
        part.name = names.get(part.callId);
      }
    }
  }
}

function ingestRecord(
  rec: Rec,
  session: IRSession,
  byUuid: Map<string, IRMessage>,
  versions: Set<string>,
  issues: ReadIssue[],
  line: number,
): void {
  if (typeof rec.version === "string") versions.add(rec.version);
  if (session.cwd === "" && typeof rec.cwd === "string") session.cwd = rec.cwd;
  const ts =
    typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : undefined;
  if (ts !== undefined && !Number.isNaN(ts)) {
    session.createdAt ??= ts;
    session.updatedAt = ts;
  }

  switch (rec.type) {
    case "user":
      ingestUser(rec, session, byUuid, issues, line);
      return;
    case "assistant":
      ingestAssistant(rec, session, byUuid, issues, line);
      return;
    case "attachment":
      ingestAttachment(rec, session, byUuid);
      return;
    case "ai-title":
      if (typeof rec.aiTitle === "string") session.title = rec.aiTitle;
      return;
    case "summary":
      // stock builds: {type:"summary", summary, leafUuid}
      if (typeof rec.summary === "string") session.title ??= rec.summary;
      pushExtension(session, rec);
      return;
    case "system":
      pushExtension(session, rec, `system:${rec.subtype ?? "unknown"}`);
      return;
    default:
      pushExtension(session, rec);
  }
}

function pushExtension(session: IRSession, rec: Rec, extType?: string): void {
  session.extensions.push({
    harness: HARNESS,
    extType: extType ?? `record:${String(rec.type)}`,
    position: session.messages.length,
    payload: rec,
  });
}

function ingestUser(
  rec: Rec,
  session: IRSession,
  byUuid: Map<string, IRMessage>,
  issues: ReadIssue[],
  line: number,
): void {
  const message = rec.message as Rec | undefined;
  if (!message) {
    issues.push({ line, kind: "user-no-message", detail: "" });
    pushExtension(session, rec);
    return;
  }

  const parts: IRPart[] = [];
  const content = message.content;
  if (typeof content === "string") {
    parts.push({ type: "text", text: content, meta: { stringContent: true } });
  } else if (Array.isArray(content)) {
    let structuredUsed = false;
    for (const block of content as Rec[]) {
      const part = userBlockToPart(block, rec, structuredUsed);
      if (part === undefined) {
        issues.push({
          line,
          kind: "unknown-user-block",
          detail: String(block.type),
        });
        parts.push({
          type: "extension",
          harness: HARNESS,
          extType: `block:${String(block.type)}`,
          payload: block,
        });
        continue;
      }
      if (part.type === "toolResult" && part.structured !== undefined) {
        structuredUsed = true;
      }
      parts.push(part);
    }
  } else {
    issues.push({ line, kind: "user-bad-content", detail: typeof content });
    pushExtension(session, rec);
    return;
  }

  // a compaction recap is Tier-1 semantics, not ordinary text
  if (rec.isCompactSummary === true) {
    const summary = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    parts.length = 0;
    parts.push({ type: "compaction", summary });
  }

  const ir = finishMessage("user", parts, rec, session);
  if (typeof rec.uuid === "string") byUuid.set(rec.uuid, ir);
}

function userBlockToPart(
  block: Rec,
  rec: Rec,
  structuredUsed: boolean,
): IRPart | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text ?? "") };
    case "image": {
      const source = block.source as Rec | undefined;
      return {
        type: "image",
        mediaType: String(source?.media_type ?? "application/octet-stream"),
        data: String(source?.data ?? ""),
      };
    }
    case "tool_result": {
      const { text, rich } = flattenResultContent(block.content);
      const part: IRToolResultPart = {
        type: "toolResult",
        callId: String(block.tool_use_id ?? ""),
        text,
        isError: block.is_error === true,
      };
      if (rich.length > 0) part.rich = rich;
      // the record-level toolUseResult envelope belongs to the first result
      if (!structuredUsed && rec.toolUseResult !== undefined) {
        part.structured = rec.toolUseResult;
      }
      return part;
    }
    default:
      return undefined;
  }
}

function flattenResultContent(content: unknown): {
  text: string;
  rich: IRImagePart[];
} {
  if (typeof content === "string") return { text: content, rich: [] };
  if (!Array.isArray(content)) return { text: "", rich: [] };
  const texts: string[] = [];
  const rich: IRImagePart[] = [];
  for (const item of content as Rec[]) {
    if (item.type === "text") {
      texts.push(String(item.text ?? ""));
    } else if (item.type === "image") {
      const source = item.source as Rec | undefined;
      rich.push({
        type: "image",
        mediaType: String(source?.media_type ?? "application/octet-stream"),
        data: String(source?.data ?? ""),
      });
    } else {
      texts.push(JSON.stringify(item));
    }
  }
  return { text: texts.join("\n"), rich };
}

function ingestAssistant(
  rec: Rec,
  session: IRSession,
  byUuid: Map<string, IRMessage>,
  issues: ReadIssue[],
  line: number,
): void {
  const message = rec.message as Rec | undefined;
  if (!message) {
    issues.push({ line, kind: "assistant-no-message", detail: "" });
    pushExtension(session, rec);
    return;
  }

  const parts: IRPart[] = [];
  const content = Array.isArray(message.content)
    ? (message.content as Rec[])
    : [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: String(block.text ?? "") });
        break;
      case "thinking":
        parts.push({
          type: "thinking",
          text: String(block.thinking ?? ""),
          ...(block.signature !== undefined && {
            signature: { provider: "anthropic", data: block.signature },
          }),
        });
        break;
      case "redacted_thinking":
        parts.push({
          type: "thinking",
          text: "",
          signature: { provider: "anthropic", data: block.data },
          meta: { redacted: true },
        });
        break;
      case "tool_use":
        parts.push({
          type: "toolCall",
          callId: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: block.input,
        });
        break;
      case "fallback":
        // model-swap marker (refusal fallback) — harness-specific, positional
        parts.push({
          type: "extension",
          harness: HARNESS,
          extType: "block:fallback",
          payload: block,
        });
        break;
      default:
        issues.push({
          line,
          kind: "unknown-assistant-block",
          detail: String(block.type),
        });
        parts.push({
          type: "extension",
          harness: HARNESS,
          extType: `block:${String(block.type)}`,
          payload: block,
        });
    }
  }

  // one API turn can be split across several records sharing message.id —
  // merge adjacent ones back into a single IR message
  const prev = session.messages.at(-1);
  const apiId = typeof message.id === "string" ? message.id : undefined;
  if (
    prev !== undefined &&
    prev.role === "assistant" &&
    apiId !== undefined &&
    prev.meta?.apiMessageId === apiId
  ) {
    prev.parts.push(...parts);
    if (typeof rec.uuid === "string") {
      prev.sourceIds!.push(rec.uuid);
      byUuid.set(rec.uuid, prev);
    }
    mergeUsage(prev, message.usage as Rec | undefined);
    return;
  }

  const ir = finishMessage("assistant", parts, rec, session);
  if (typeof message.model === "string") {
    ir.model = { provider: "anthropic", id: message.model };
  }
  if (apiId !== undefined) {
    ir.meta = { ...ir.meta, apiMessageId: apiId };
  }
  mergeUsage(ir, message.usage as Rec | undefined);
  if (typeof rec.uuid === "string") byUuid.set(rec.uuid, ir);
}

function mergeUsage(ir: IRMessage, usage: Rec | undefined): void {
  if (!usage) return;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;
  const add = (a: number | undefined, b: number | undefined) =>
    b === undefined ? a : (a ?? 0) + b;
  ir.usage = {
    inputTokens: add(ir.usage?.inputTokens, num(usage.input_tokens)),
    outputTokens: add(ir.usage?.outputTokens, num(usage.output_tokens)),
    cacheReadTokens: add(
      ir.usage?.cacheReadTokens,
      num(usage.cache_read_input_tokens),
    ),
    cacheWriteTokens: add(
      ir.usage?.cacheWriteTokens,
      num(usage.cache_creation_input_tokens),
    ),
  };
}

/**
 * `attachment` records are a polymorphic union of injected context: file
 * @-mentions (`content.file`), plus harness notices (MCP server diffs, tool
 * availability changes, directory listings, …). File content maps to an
 * attachment part; every other variant stays an extension part on the parent
 * message so its position in the conversation survives conversion.
 */
function ingestAttachment(
  rec: Rec,
  session: IRSession,
  byUuid: Map<string, IRMessage>,
): void {
  const attachment = rec.attachment as Rec | undefined;
  const parent =
    typeof rec.parentUuid === "string" ? byUuid.get(rec.parentUuid) : undefined;
  const target = parent ?? session.messages.at(-1);
  if (attachment === undefined || target === undefined) {
    pushExtension(session, rec);
    return;
  }
  const content = attachment.content as Rec | undefined;
  const file = content?.file as Rec | undefined;
  if (file) {
    target.parts.push({
      type: "attachment",
      path: typeof file.filePath === "string" ? file.filePath : undefined,
      text: typeof file.content === "string" ? file.content : undefined,
      meta: { attachment },
    });
  } else {
    target.parts.push({
      type: "extension",
      harness: HARNESS,
      extType: `attachment:${String(attachment.type)}`,
      payload: rec,
    });
  }
}

function finishMessage(
  role: IRMessage["role"],
  parts: IRPart[],
  rec: Rec,
  session: IRSession,
): IRMessage {
  const meta: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) {
    if (rec[key] !== undefined) meta[key] = rec[key];
  }
  if (typeof rec.cwd === "string" && rec.cwd !== session.cwd) {
    meta.cwd = rec.cwd;
  }
  const ts =
    typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : undefined;
  const ir: IRMessage = {
    id: newId(),
    role,
    parts,
    sourceIds: typeof rec.uuid === "string" ? [rec.uuid] : [],
    ...(ts !== undefined && !Number.isNaN(ts) && { timestamp: ts }),
    ...(Object.keys(meta).length > 0 && { meta }),
  };
  session.messages.push(ir);
  return ir;
}

async function readSubagents(
  filePath: string,
  parent: ReadResult,
): Promise<IRChildSession[]> {
  const children = parent.session.children;
  const dir = join(
    dirname(filePath),
    basename(filePath, ".jsonl"),
    "subagents",
  );
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return children;

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const childPath = join(dir, entry);
    const text = await Bun.file(childPath).text();
    const childResult = parseRecords(text, childPath, true);
    parent.issues.push(...childResult.issues);

    const child: IRChildSession = { session: childResult.session };
    const meta = await Bun.file(
      childPath.replace(/\.jsonl$/, ".meta.json"),
    )
      .json()
      .catch(() => null);
    if (meta !== null) {
      if (typeof meta.toolUseId === "string") child.linkedCallId = meta.toolUseId;
      if (typeof meta.agentType === "string") child.agentType = meta.agentType;
      if (typeof meta.description === "string") {
        child.description = meta.description;
      }
    }
    children.push(child);
  }
  return reparentNested(children);
}

/**
 * `subagents/` is flat: an agent spawned by another agent sits beside its
 * spawner. Re-parent each child under whichever transcript actually issued
 * its linked tool call; children called from the main session stay top-level.
 */
function reparentNested(children: IRChildSession[]): IRChildSession[] {
  const owners = new Map<string, IRChildSession>();
  for (const child of children) {
    for (const msg of child.session.messages) {
      for (const part of msg.parts) {
        if (part.type === "toolCall") owners.set(part.callId, child);
      }
    }
  }
  const topLevel: IRChildSession[] = [];
  for (const child of children) {
    const owner =
      child.linkedCallId !== undefined
        ? owners.get(child.linkedCallId)
        : undefined;
    if (owner !== undefined && owner !== child) {
      owner.session.children.push(child);
    } else {
      topLevel.push(child);
    }
  }
  return topLevel;
}

// ---------------------------------------------------------------------------
// Writer

/**
 * Write IR as a native Claude Code JSONL session. Claude Code discovers
 * sessions by cwd bucket, so placement is part of the format rather than a
 * separate index write.
 */
export async function writeClaudeSession(
  ir: IRSession,
  claudeHome: string,
): Promise<ClaudeWriteResult> {
  const sessionId = crypto.randomUUID();
  const projectDir = join(claudeHome, "projects", claudeProjectDir(ir.cwd));
  const filePath = join(projectDir, `${sessionId}.jsonl`);
  await mkdir(projectDir, { recursive: true });

  const version = ir.source.versions?.at(-1) ?? "0.0.2";
  const rendered = renderClaudeSession(ir, sessionId, version, false);
  await Bun.write(filePath, rendered);

  const subagentsDir = join(projectDir, sessionId, "subagents");
  const flatChildren: IRChildSession[] = [];
  flattenChildren(ir.children, flatChildren);
  if (flatChildren.length > 0) await mkdir(subagentsDir, { recursive: true });
  for (const child of flatChildren) {
    const agentId = nativeAgentId();
    const childPath = join(subagentsDir, `agent-${agentId}.jsonl`);
    await Bun.write(
      childPath,
      renderClaudeSession(child.session, sessionId, version, true, agentId),
    );
    await Bun.write(
      childPath.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({
        ...(child.agentType !== undefined && { agentType: child.agentType }),
        ...(child.description !== undefined && {
          description: child.description,
        }),
        ...(child.linkedCallId !== undefined && {
          toolUseId: child.linkedCallId,
        }),
      }),
    );
  }

  return {
    filePath,
    sessionId,
    displayId: sessionId.slice(0, 8),
    resumeHint: text.resumeClaude(sessionId),
  };
}

function flattenChildren(
  children: IRChildSession[],
  into: IRChildSession[],
): void {
  for (const child of children) {
    into.push(child);
    flattenChildren(child.session.children, into);
  }
}

function renderClaudeSession(
  ir: IRSession,
  sessionId: string,
  version: string,
  isSidechain: boolean,
  agentId?: string,
): string {
  const records: Rec[] = [];
  let parentUuid: string | null = null;
  const startedAt = ir.createdAt ?? Date.now();
  const base = (timestamp: number): Rec => ({
    parentUuid,
    isSidechain,
    timestamp: new Date(timestamp).toISOString(),
    cwd: ir.cwd,
    sessionId,
    version,
    gitBranch: "HEAD",
    userType: "external",
    entrypoint: "cli",
    ...(agentId !== undefined && { agentId }),
  });
  const pushChained = (record: Rec, timestamp: number): string => {
    const uuid = crypto.randomUUID();
    records.push({ ...base(timestamp), ...record, uuid });
    parentUuid = uuid;
    return uuid;
  };

  if (!isSidechain) {
    records.push({ type: "mode", mode: "normal", sessionId });
    records.push({
      type: "permission-mode",
      permissionMode: "default",
      sessionId,
    });
  }

  for (const message of ir.messages) {
    const timestamp = message.timestamp ?? startedAt;
    if (message.role === "assistant") {
      const content: Rec[] = [];
      for (const part of message.parts) {
        switch (part.type) {
          case "text":
            content.push({ type: "text", text: part.text });
            break;
          case "thinking":
            if (part.signature?.provider === "anthropic") {
              content.push({
                type: "thinking",
                thinking: part.text,
                signature: String(part.signature.data),
              });
            } else if (part.text !== "") {
              // Cross-provider plaintext reasoning cannot be replayed as an
              // Anthropic thinking block without a signature. Preserve it as
              // ordinary historical text instead of fabricating a signature.
              content.push({ type: "text", text: part.text });
            }
            break;
          case "toolCall":
            content.push({
              type: "tool_use",
              id: part.callId,
              name: part.name,
              input: part.input ?? {},
            });
            break;
          case "compaction":
            if (part.summary !== undefined) {
              content.push({ type: "text", text: part.summary });
            }
            break;
          case "extension":
            content.push(claudeBlockOrText(part));
            break;
          case "image":
          case "attachment":
          case "toolResult":
            content.push({ type: "text", text: degradedPartText(part) });
            break;
        }
      }
      if (content.length === 0) continue;
      const usage = message.usage;
      pushChained(
        {
          type: "assistant",
          requestId: `req_${randomHex(12)}`,
          message: {
            model: message.model?.id ?? "unknown",
            id: `msg_${randomAlphaNum(24)}`,
            type: "message",
            role: "assistant",
            content,
            stop_reason: content.at(-1)?.type === "tool_use" ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: usage?.inputTokens ?? 0,
              output_tokens: usage?.outputTokens ?? 0,
              cache_read_input_tokens: usage?.cacheReadTokens ?? 0,
              cache_creation_input_tokens: usage?.cacheWriteTokens ?? 0,
            },
          },
        },
        timestamp,
      );
      continue;
    }

    let content: Rec[] = [];
    let emittedForMessage = false;
    let structured: unknown;
    const flushUser = (
      options: { compact?: boolean; force?: boolean } = {},
    ): void => {
      if (content.length === 0 && options.force !== true) return;
      const simpleText =
        content.length === 1 && content[0]?.type === "text"
          ? String(content[0].text ?? "")
          : content;
      pushChained(
        {
          type: "user",
          promptId: crypto.randomUUID(),
          promptSource: "typed",
          permissionMode: "default",
          message: { role: "user", content: simpleText },
          ...(options.compact === true && { isCompactSummary: true }),
          ...(structured !== undefined && { toolUseResult: structured }),
        },
        timestamp,
      );
      emittedForMessage = true;
      content = [];
      structured = undefined;
    };
    const writeAttachment = (attachment: {
      path?: string;
      text?: string;
    }): void => {
      // Attachments are separate records in Claude's format. Flush first so
      // their relative position within a mixed IR message is not moved to the
      // end; an empty user record is the native parent for attachment-only
      // messages and reads back as the same single attachment part.
      flushUser({ force: !emittedForMessage });
      const path = attachment.path ?? "attachment";
      const attachmentText = attachment.text ?? "";
      const lines = attachmentText.split("\n").length;
      pushChained(
        {
          type: "attachment",
          attachment: {
            type: "file",
            filename: path,
            displayPath: path,
            content: {
              type: "text",
              file: {
                filePath: path,
                content: attachmentText,
                numLines: lines,
                startLine: 1,
                totalLines: lines,
              },
            },
          },
        },
        timestamp,
      );
    };

    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          content.push({ type: "text", text: part.text });
          break;
        case "image":
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.mediaType,
              data: part.data,
            },
          });
          break;
        case "attachment":
          writeAttachment(part);
          break;
        case "toolResult": {
          // Claude stores structured result data once on the user envelope.
          // Isolate a structured result so the reader associates that envelope
          // with the correct tool_result block when a batch has several.
          if (part.structured !== undefined) flushUser();
          const rich: Rec[] = [{ type: "text", text: part.text }];
          for (const image of part.rich ?? []) {
            rich.push({
              type: "image",
              source: {
                type: "base64",
                media_type: image.mediaType,
                data: image.data,
              },
            });
          }
          content.push({
            type: "tool_result",
            tool_use_id: part.callId,
            content: rich.length === 1 ? part.text : rich,
            is_error: part.isError,
          });
          if (part.structured !== undefined) {
            structured = part.structured;
            flushUser();
          }
          break;
        }
        case "compaction":
          flushUser();
          content.push({ type: "text", text: part.summary ?? "" });
          flushUser({ compact: true });
          break;
        case "extension": {
          const nativeAttachment = claudeAttachment(part);
          if (nativeAttachment !== undefined) {
            flushUser({ force: !emittedForMessage });
            pushChained(
              { type: "attachment", attachment: nativeAttachment },
              timestamp,
            );
          } else {
            content.push(claudeBlockOrText(part));
          }
          break;
        }
        case "thinking":
        case "toolCall":
          content.push({ type: "text", text: degradedPartText(part) });
          break;
      }
    }
    flushUser();
  }

  if (!isSidechain && ir.title !== undefined) {
    records.push({ type: "ai-title", aiTitle: ir.title, sessionId });
  }
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function claudeBlockOrText(
  part: Extract<IRPart, { type: "extension" }>,
): Rec {
  if (
    part.harness === HARNESS &&
    part.extType.startsWith("block:") &&
    isRecord(part.payload)
  ) {
    return part.payload;
  }
  return { type: "text", text: degradedPartText(part) };
}

function claudeAttachment(
  part: Extract<IRPart, { type: "extension" }>,
): Rec | undefined {
  if (
    part.harness !== HARNESS ||
    !part.extType.startsWith("attachment:") ||
    !isRecord(part.payload)
  ) {
    return undefined;
  }
  const attachment = part.payload.attachment;
  return isRecord(attachment) ? attachment : undefined;
}

/** Model-visible parts that cannot inhabit their IR role in Claude history are
 * kept as text at the same position rather than silently disappearing. */
function degradedPartText(part: IRPart): string {
  switch (part.type) {
    case "text":
    case "thinking":
      return part.text;
    case "toolCall":
      return `[tool call: ${part.name}]\n${safeJson(part.input)}`;
    case "toolResult":
      return `[tool result: ${part.name ?? part.callId}]\n${part.text}`;
    case "image":
      return `[image: data:${part.mediaType};base64,${part.data}]`;
    case "attachment":
      return `${part.path !== undefined ? `@${part.path}\n` : ""}${part.text ?? ""}`;
    case "compaction":
      return part.summary ?? "";
    case "extension":
      return `[${part.harness}:${part.extType}]\n${safeJson(part.payload)}`;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeAgentId(): string {
  return `a${randomHex(8)}`;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomAlphaNum(length: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => alphabet[b % alphabet.length]).join("");
}
