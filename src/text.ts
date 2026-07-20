/**
 * Every user-facing string chagent prints, in one place — edit freely.
 * Code only fills the ${} slots; where each line goes (stdout/stderr) and
 * exit codes are decided by callers, never here. Catalog: COMPAT.md §7.
 */

import pkg from "../package.json";

export const VERSION: string = pkg.version;

export const text = {
  // ---- banner / meta -------------------------------------------------------
  banner: `chagent v${VERSION}`,
  version: `chagent v${VERSION}`,
  usage: `usage: chagent <session-id> <target-harness>
       chagent ls
try 'chagent --help' for more information`,

  help: `chagent — move agent sessions between coding-agent harnesses

usage:
  chagent <session-id> <target-harness>    convert a session
  chagent ls                               list this directory's sessions
  chagent -h, --help                       show this help
  chagent -v, -V, --version                show version

session ids:
  a full session id, a unique prefix (git-style), or a qualified form
  like claude:6071d393 or pi:019f60bb. bare ids are searched across
  every harness (claude, pi, opencode, codex); an ambiguous prefix
  fails and lists the qualified candidates.

targets:
  claude      writes into ~/.claude/projects
  pi          writes into ~/.pi/agent/sessions
  opencode    writes into ~/.local/share/opencode/opencode.db
  codex       writes into ~/.codex/sessions (+ resume index)

options:
  --target-home <dir>    write into <dir> instead of the harness's real
                         home (mainly for dry runs and testing)

exit codes:
  0    session written; warnings may appear on stderr as "note: ..."
  1    session not found, ambiguous id, or write failure
  2    usage error

example:
  $ chagent 6071d393 pi
  chagent v${VERSION}
  loading claude:6071d393-f90a-4dcd-a914-c861a3c29d99...
  loaded 228 messages, 5 subagents in 40.2ms
  preparing ir
  prepared 1223 parts
  writing ir to pi
  wrote 1223 ir parts to pi 019f7a30

  pi --session 019f7a30

the last line is always the command that resumes the converted session.`,

  // ---- convert: progress (stdout) ------------------------------------------
  loading: (qualifiedId: string) => `loading ${qualifiedId}...`,
  loaded: (messages: number, subagents: number, ms: string) =>
    `loaded ${messages} messages, ${subagents} subagents in ${ms}ms`,
  preparing: "preparing ir",
  prepared: (parts: number) => `prepared ${parts} parts`,
  writing: (target: string) => `writing ir to ${target}`,
  wrote: (parts: number, target: string, id: string) =>
    `wrote ${parts} ir parts to ${target} ${id}`,

  // ---- convert: resolution errors (stderr) ---------------------------------
  ambiguous: (id: string) => `ambiguous id ${id}:`,
  ambiguousCandidate: (qualifiedId: string) => `  ${qualifiedId}`,
  noMatch: (id: string) => `no session matching ${id}`,
  unsupportedTarget: (target: string) =>
    `unsupported target: ${target} (targets: claude, pi, opencode, codex)`,
  writeError: (message: string) => `error: ${message}`,

  // ---- convert: non-fatal notes (stderr, exit stays 0) ---------------------
  readNote: (kind: string, line: number) => `note: ${kind} at line ${line}`,
  codexNoIndexDb:
    "note: no state_5.sqlite in target — session written, won't appear in resume pickers",
  codexNoIndexTables:
    "note: codex index tables not found — session written, won't appear in resume pickers",
  codexIndexFailed: (err: string) =>
    `note: could not index session (schema drift?): ${err} — session written, resume with the printed id`,

  // ---- writer hard errors (thrown; printed via writeError) -----------------
  opencodeDbMissing: (path: string) =>
    `opencode database not found at ${path} — chagent never creates harness stores`,
  opencodeTablesMissing: (path: string) =>
    `${path} is missing opencode tables — refusing to write`,

  // ---- resume hints (final stdout line, after a blank line) ----------------
  resumeClaude: (id: string) => `claude -r ${id}`,
  resumePi: (id: string) => `pi --session ${id}`,
  resumeOpencode: (id: string) => `opencode -s ${id}`,
  resumeCodex: (idOrPath: string) => `codex resume ${idOrPath}`,

  // ---- ls ------------------------------------------------------------------
  lsEmpty: "no sessions found for this directory",

  // added: ls
  lsMsgs: (paddedCount: string) => `${paddedCount} msgs`,
  lsUntitled: "(untitled)",
};
