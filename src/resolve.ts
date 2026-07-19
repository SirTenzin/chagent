/**
 * Automatic session-id resolution across all harnesses (COMPAT.md §7).
 *
 * A bare id (or unique prefix) is searched across every harness's store;
 * `<harness>:<id>` restricts the search. An exact-id match wins over prefix
 * matches (git-style); anything still ambiguous is the caller's error to
 * report. Missing stores contribute no candidates rather than failing.
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ReadResult, SessionRef } from "./ir.ts";
import {
  listClaudeSessions,
  readClaudeSession,
} from "./adapters/claude-code.ts";
import { listPiSessions, readPiSession } from "./adapters/pi.ts";
import {
  listOpenCodeSessions,
  readOpenCodeSession,
} from "./adapters/opencode.ts";
import { listCodexSessions, readCodexSession } from "./adapters/codex.ts";

export const SOURCE_HARNESSES = ["claude", "pi", "opencode", "codex"] as const;
export type SourceHarness = (typeof SOURCE_HARNESSES)[number];

export type Resolution =
  | { ok: true; ref: SessionRef }
  | { ok: false; kind: "none" }
  | { ok: false; kind: "ambiguous"; candidates: SessionRef[] };

export async function resolveSession(idArg: string): Promise<Resolution> {
  let harness: SourceHarness | undefined;
  let id = idArg;
  const colon = idArg.indexOf(":");
  if (colon !== -1) {
    const prefix = idArg.slice(0, colon);
    if ((SOURCE_HARNESSES as readonly string[]).includes(prefix)) {
      harness = prefix as SourceHarness;
      id = idArg.slice(colon + 1);
    }
  }

  const refs = await listSessions(harness);
  const exact = refs.filter((r) => r.id === id);
  if (exact.length === 1) return { ok: true, ref: exact[0]! };
  const matches = refs.filter((r) => r.id.startsWith(id));
  if (matches.length === 0) return { ok: false, kind: "none" };
  if (matches.length === 1) return { ok: true, ref: matches[0]! };
  matches.sort((a, b) =>
    `${a.harness}:${a.id}`.localeCompare(`${b.harness}:${b.id}`),
  );
  return { ok: false, kind: "ambiguous", candidates: matches };
}

export function readSession(ref: SessionRef): Promise<ReadResult> {
  switch (ref.harness) {
    case "claude":
      return readClaudeSession(ref.locator);
    case "pi":
      return readPiSession(ref.locator);
    case "opencode":
      return readOpenCodeSession(ref.locator);
    case "codex":
      return readCodexSession(ref.locator);
    default:
      throw new Error(`no reader for harness ${ref.harness}`);
  }
}

async function listSessions(
  only: SourceHarness | undefined,
): Promise<SessionRef[]> {
  const wants = (h: SourceHarness) => only === undefined || only === h;
  const home = homedir();
  const lists = await Promise.all([
    wants("claude") ? claudeRefs(join(home, ".claude")) : [],
    wants("pi") ? swallow(() => listPiSessions(join(home, ".pi/agent"))) : [],
    wants("opencode")
      ? swallow(() =>
          listOpenCodeSessions(
            join(home, ".local/share/opencode/opencode.db"),
          ),
        )
      : [],
    wants("codex") ? swallow(() => listCodexSessions(join(home, ".codex"))) : [],
  ]);
  return lists.flat();
}

async function claudeRefs(claudeHome: string): Promise<SessionRef[]> {
  const files = await swallow(() => listClaudeSessions(claudeHome));
  return files.map((f) => ({
    harness: "claude",
    id: basename(f, ".jsonl"),
    locator: f,
  }));
}

/** a missing/unreadable store yields no candidates, never an error */
async function swallow<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
