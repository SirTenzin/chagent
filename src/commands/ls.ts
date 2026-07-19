/**
 * ls command — sessions for the current directory, newest first.
 * Claude Code only for now (the only reader); rows carry a `claude:` prefix
 * so other harnesses slot in later. No banner, no headers (COMPAT.md §7).
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { listClaudeSessions } from "../adapters/claude-code.ts";
import { text } from "../text.ts";

const MAX_ROW = 100;

interface Row {
  id: string;
  mtimeMs: number;
  messages: number;
  title: string;
}

export async function runLs(): Promise<number> {
  const files = await listClaudeSessions(`${homedir()}/.claude`, process.cwd());
  const rows: Row[] = [];
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (info === null) continue;
    const body = await Bun.file(file).text();
    rows.push({
      id: basename(file, ".jsonl"),
      mtimeMs: info.mtimeMs,
      messages: countMessages(body),
      title: findTitle(body),
    });
  }

  if (rows.length === 0) {
    console.log(text.lsEmpty);
    return 0;
  }

  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const countWidth = Math.max(...rows.map((r) => String(r.messages).length));
  for (const row of rows) {
    const id = `claude:${row.id.slice(0, 8)}`;
    const when = formatLocal(row.mtimeMs);
    const messages = text.lsMsgs(String(row.messages).padStart(countWidth));
    const prefix = `${id}  ${when}  ${messages}  `;
    console.log(prefix + clip(row.title, MAX_ROW - prefix.length));
  }
  return 0;
}

/**
 * Cheap message count. A line counts when it contains the raw sequence
 * `"type":"user"` or `"type":"assistant"`: inside JSON string values every
 * quote is escaped (`\"`), so the unescaped sequence can only appear as real
 * JSON structure. Accepted imprecision (ls is display-only): a nested object
 * literally shaped `{"type":"user"}` inside a tool payload counts once, and
 * the reader's uuid-dedupe/assistant-merge isn't replicated — this scans a
 * 60MB file in tens of ms where a full parse takes seconds.
 */
function countMessages(body: string): number {
  let count = 0;
  let start = 0;
  while (start <= body.length) {
    const end = body.indexOf("\n", start);
    const line = body.slice(start, end === -1 ? body.length : end);
    if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
      count++;
    }
    if (end === -1) break;
    start = end + 1;
  }
  return count;
}

/** latest ai-title record, else summary, else first typed user line */
function findTitle(body: string): string {
  const lines = body.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"type":"ai-title"')) continue;
    const title = parseField(line, "aiTitle");
    if (title !== undefined) return title;
  }
  for (const line of lines) {
    if (!line.includes('"type":"summary"')) continue;
    const title = parseField(line, "summary");
    if (title !== undefined) return title;
  }

  // first genuinely-typed user text; skip meta/command wrappers
  let inspected = 0;
  for (const line of lines) {
    if (!line.includes('"type":"user"')) continue;
    if (++inspected > 20) break;
    try {
      const rec = JSON.parse(line);
      if (rec.type !== "user" || rec.isMeta === true) continue;
      const content = rec.message?.content;
      const raw =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.find((b: { type?: string }) => b.type === "text")?.text
            : undefined;
      if (typeof raw !== "string") continue;
      const first = clean(raw).split("\n")[0]!.trim();
      if (first !== "" && !first.startsWith("<")) return first;
    } catch {
      // partial/truncated line — skip
    }
  }
  return text.lsUntitled;
}

function parseField(line: string, field: string): string | undefined {
  try {
    const value = JSON.parse(line)[field];
    if (typeof value === "string" && value.trim() !== "") return clean(value);
  } catch {
    // not a lone JSON record — skip
  }
  return undefined;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  if (max <= 1) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
