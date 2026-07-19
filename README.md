# chagent

`chsh` for coding agents: move a session from one agent CLI to another and keep
working. Reads Claude Code sessions; writes Pi, OpenCode, and Codex.

## install

```sh
bun install -g chagent
```

## use

```
$ chagent 6071d393 pi
chagent v0.0.1
loading claude:6071d393-f90a-4dcd-a914-c861a3c29d99...
loaded 228 messages, 5 subagents in 40.2ms
preparing ir
prepared 1223 parts
writing ir to pi
wrote 1223 ir parts to pi 019f7a30

pi --session 019f7a30
```

The last line is always the command that resumes the converted session.
`chagent ls` lists this directory's sessions; `chagent --help` for the rest.

## compatibility

| | claude code | pi | opencode | codex |
|---|---|---|---|---|
| direction | read | write | write | write |
| text, images, attachments | ✓ | ✓ | ✓ | ✓ |
| shell / edit / write tool calls | ✓ | ✓ | ✓ | ✓ native |
| other tool calls | ✓ | ✓ | ✓ | passthrough¹ |
| thinking | ✓ | ✓ | ✓ | plaintext only |
| subagent transcripts | ✓ | ✓ | ✓ | ✓ |
| compaction | ✓ | ✓ | ✓ | ✓ |
| model + token usage | ✓ | ✓ | ✓ | ✓ (cost dropped) |
| resume-picker integration | — | ✓ | ✓ | ✓ |

¹ unmapped tools convert verbatim — the model sees them in history, but some
TUIs don't render tools they don't recognize.