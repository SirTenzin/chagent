#!/usr/bin/env bun
/**
 * chagent — move agent sessions between harnesses.
 * Bare-bones CLI per COMPAT.md §7: plaintext, no interactivity, GNU-style.
 * All user-facing strings live in src/text.ts.
 */
import { text } from "./src/text.ts";
import { runConvert } from "./src/commands/convert.ts";
import { runLs } from "./src/commands/ls.ts";

const argv = process.argv.slice(2);

const flags = new Set(argv.filter((a) => a.startsWith("-")));
if (flags.has("-v") || flags.has("-V") || flags.has("--version")) {
  console.log(text.version);
  process.exit(0);
}
if (argv.length === 0 || flags.has("-h") || flags.has("--help")) {
  console.log(text.help);
  process.exit(0);
}

let targetHome: string | undefined;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--target-home") targetHome = argv[++i];
  else if (arg.startsWith("-")) {
    console.error(text.usage);
    process.exit(2);
  } else positional.push(arg);
}

if (positional[0] === "ls" && positional.length === 1) {
  process.exit(await runLs());
}
if (positional.length !== 2) {
  console.error(text.usage);
  process.exit(2);
}
process.exit(await runConvert(positional[0]!, positional[1]!, targetHome));
