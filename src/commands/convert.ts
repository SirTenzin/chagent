/**
 * convert command — `chagent <session-id> <target-harness>`.
 * Output contract: COMPAT.md §7; every printed string lives in src/text.ts.
 * stdout = progress + resume hint; stderr = errors and notes.
 * Exit codes: 0 written (notes allowed), 1 resolution/write failure,
 * 2 unsupported target (usage error).
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { text } from "../text.ts";
import {
  listClaudeSessions,
  readClaudeSession,
} from "../adapters/claude-code.ts";
import { writePiSession } from "../adapters/pi.ts";
import { writeOpenCodeSession } from "../adapters/opencode.ts";
import { writeCodexSession } from "../adapters/codex.ts";
import type { IRSession } from "../ir.ts";

const TARGETS = ["pi", "opencode", "codex"] as const;
type Target = (typeof TARGETS)[number];

export async function runConvert(
  idArg: string,
  target: string,
  targetHome: string | undefined,
): Promise<number> {
  console.log(text.banner);
  if (!TARGETS.includes(target as Target)) {
    console.error(text.unsupportedTarget(target));
    return 2;
  }

  const started = performance.now();
  const id = idArg.startsWith("claude:")
    ? idArg.slice("claude:".length)
    : idArg;
  const all = await listClaudeSessions(`${homedir()}/.claude`);
  const matches = all.filter((f) => basename(f, ".jsonl").startsWith(id));
  if (matches.length === 0) {
    console.error(text.noMatch(idArg));
    return 1;
  }
  if (matches.length > 1) {
    console.error(text.ambiguous(idArg));
    for (const m of matches) {
      console.error(text.ambiguousCandidate(`claude:${basename(m, ".jsonl")}`));
    }
    return 1;
  }

  const file = matches[0]!;
  console.log(text.loading(`claude:${basename(file, ".jsonl")}`));
  const { session, issues } = await readClaudeSession(file);
  console.log(
    text.loaded(
      session.messages.length,
      session.children.length,
      (performance.now() - started).toFixed(1),
    ),
  );
  for (const issue of issues) {
    if (!issue.kind.startsWith("truncated")) {
      console.error(text.readNote(issue.kind, issue.line));
    }
  }

  console.log(text.preparing);
  const parts = countParts(session);
  console.log(text.prepared(parts));

  console.log(text.writing(target));
  try {
    const result = await write(session, target as Target, targetHome);
    console.log(text.wrote(parts, target, result.displayId));
    console.log();
    console.log(result.resumeHint);
    return 0;
  } catch (err) {
    console.error(
      text.writeError(err instanceof Error ? err.message : String(err)),
    );
    return 1;
  }
}

interface Written {
  displayId: string;
  resumeHint: string;
}

function write(
  ir: IRSession,
  target: Target,
  home: string | undefined,
): Promise<Written> {
  switch (target) {
    case "pi":
      return writePiSession(ir, home ?? join(homedir(), ".pi/agent"));
    case "opencode":
      return writeOpenCodeSession(
        ir,
        join(home ?? join(homedir(), ".local/share/opencode"), "opencode.db"),
      );
    case "codex":
      return writeCodexSession(ir, home ?? join(homedir(), ".codex"));
  }
}

function countParts(s: IRSession): number {
  let n = 0;
  for (const m of s.messages) n += m.parts.length;
  for (const c of s.children) n += countParts(c.session);
  return n;
}
