import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRPart, IRSession } from "../ir.ts";
import {
  claudeProjectDir,
  readClaudeSession,
  writeClaudeSession,
} from "./claude-code.ts";
import { readPiSession, writePiSession } from "./pi.ts";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempHome(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

function session(
  overrides: Partial<IRSession> & Pick<IRSession, "cwd" | "messages">,
): IRSession {
  return {
    id: crypto.randomUUID(),
    source: { harness: "pi", id: crypto.randomUUID() },
    children: [],
    extensions: [],
    ...overrides,
  };
}

function semanticParts(ir: IRSession): { role: string; part: unknown }[] {
  return ir.messages.flatMap((message) =>
    message.parts.map((part) => ({
      role: message.role,
      part: semanticPart(part),
    })),
  );
}

function semanticPart(part: IRPart): unknown {
  switch (part.type) {
    case "text":
      return { type: part.type, text: part.text };
    case "thinking":
      return {
        type: part.type,
        text: part.text,
        signature: part.signature,
      };
    case "toolCall":
      return {
        type: part.type,
        callId: part.callId,
        name: part.name,
        input: part.input,
      };
    case "toolResult":
      return {
        type: part.type,
        callId: part.callId,
        name: part.name,
        text: part.text,
        rich: part.rich?.map(semanticPart),
        isError: part.isError,
        structured: part.structured,
      };
    case "image":
      return {
        type: part.type,
        mediaType: part.mediaType,
        data: part.data,
      };
    case "attachment":
      return {
        type: part.type,
        path: part.path,
        text: part.text,
      };
    case "compaction":
      return { type: part.type, summary: part.summary };
    case "extension":
      return {
        type: part.type,
        harness: part.harness,
        extType: part.extType,
        payload: part.payload,
      };
  }
}

describe("Claude Code writer", () => {
  test("writes native JSONL in the cwd bucket and round-trips parts and children", async () => {
    const home = await tempHome("chagent-claude-");
    const cwd = "/tmp/project.with dots";
    const nested = session({
      cwd,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "nested answer" }],
        },
      ],
    });
    const child = session({
      cwd,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "child prompt" }],
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [
            {
              type: "toolCall",
              callId: "child-call",
              name: "Agent",
              input: { prompt: "nested" },
            },
          ],
        },
      ],
      children: [
        {
          session: nested,
          linkedCallId: "child-call",
          agentType: "Explore",
          description: "nested child",
        },
      ],
    });
    const input = session({
      cwd,
      source: {
        harness: "claude",
        id: crypto.randomUUID(),
        versions: ["2.1.215"],
      },
      title: "Imported session",
      createdAt: Date.parse("2026-07-20T12:00:00.000Z"),
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            { type: "text", text: "hello" },
            { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
          ],
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          model: { provider: "anthropic", id: "claude-test" },
          usage: {
            inputTokens: 4,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
          },
          parts: [
            {
              type: "thinking",
              text: "reasoning",
              signature: { provider: "anthropic", data: "signature" },
            },
            { type: "text", text: "working" },
            {
              type: "toolCall",
              callId: "first-result",
              name: "Read",
              input: { file_path: "/tmp/first" },
            },
            {
              type: "toolCall",
              callId: "second-result",
              name: "Read",
              input: { file_path: "/tmp/second" },
            },
            {
              type: "toolCall",
              callId: "root-call",
              name: "Agent",
              input: { prompt: "child" },
            },
          ],
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "toolResult",
              callId: "first-result",
              name: "Read",
              text: "first",
              isError: false,
              structured: { filePath: "/tmp/first" },
            },
            {
              type: "toolResult",
              callId: "second-result",
              name: "Read",
              text: "second",
              rich: [
                { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
              ],
              isError: true,
              structured: { filePath: "/tmp/second" },
            },
          ],
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "attachment",
              path: "/tmp/context.txt",
              text: "one\ntwo",
            },
          ],
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "compaction", summary: "summary" }],
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [
            {
              type: "extension",
              harness: "claude",
              extType: "block:fallback",
              payload: { type: "fallback", reason: "model swap" },
            },
          ],
        },
      ],
      children: [
        {
          session: child,
          linkedCallId: "root-call",
          agentType: "general-purpose",
          description: "top child",
        },
      ],
    });

    const written = await writeClaudeSession(input, home);
    expect(written.filePath).toBe(
      join(home, "projects", claudeProjectDir(cwd), `${written.sessionId}.jsonl`),
    );
    expect(written.displayId).toBe(written.sessionId.slice(0, 8));
    expect(written.resumeHint).toBe(`claude -r ${written.sessionId}`);

    const records = (await Bun.file(written.filePath).text())
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toEqual({
      type: "mode",
      mode: "normal",
      sessionId: written.sessionId,
    });
    expect(records[1]).toEqual({
      type: "permission-mode",
      permissionMode: "default",
      sessionId: written.sessionId,
    });
    const chained = records.filter((record) => typeof record.uuid === "string");
    for (let i = 0; i < chained.length; i++) {
      expect(chained[i].parentUuid).toBe(i === 0 ? null : chained[i - 1].uuid);
      expect(chained[i].cwd).toBe(cwd);
      expect(chained[i].sessionId).toBe(written.sessionId);
    }

    const roundTrip = await readClaudeSession(written.filePath);
    expect(roundTrip.issues).toEqual([]);
    expect(roundTrip.session.title).toBe(input.title);
    expect(semanticParts(roundTrip.session)).toEqual(semanticParts(input));
    expect(roundTrip.session.children).toHaveLength(1);
    const readChild = roundTrip.session.children[0]!;
    expect(readChild.linkedCallId).toBe("root-call");
    expect(readChild.agentType).toBe("general-purpose");
    expect(readChild.description).toBe("top child");
    expect(semanticParts(readChild.session)).toEqual(semanticParts(child));
    expect(readChild.session.children).toHaveLength(1);
    expect(readChild.session.children[0]!.linkedCallId).toBe("child-call");
    expect(semanticParts(readChild.session.children[0]!.session)).toEqual(
      semanticParts(nested),
    );
  });

  test("round-trips a Pi session through scratch homes without touching real stores", async () => {
    const root = await tempHome("chagent-pi-claude-");
    const piHome = join(root, "pi");
    const claudeHome = join(root, "claude");
    const cwd = "/tmp/pi-to-claude";
    const child = session({
      cwd,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "child output" }],
        },
      ],
    });
    const input = session({
      cwd,
      createdAt: Date.parse("2026-07-20T13:00:00.000Z"),
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "run it" }],
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          model: { provider: "anthropic", id: "claude-test" },
          parts: [
            {
              type: "thinking",
              text: "think",
              signature: { provider: "anthropic", data: "sig" },
            },
            {
              type: "toolCall",
              callId: "call-1",
              name: "bash",
              input: { command: "printf ok" },
            },
          ],
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "toolResult",
              callId: "call-1",
              name: "bash",
              text: "ok",
              rich: [
                { type: "image", mediaType: "image/png", data: "cG5n" },
              ],
              isError: false,
              structured: { exitCode: 0 },
            },
          ],
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "compaction", summary: "earlier work" }],
        },
      ],
      children: [
        {
          session: child,
          agentType: "worker",
          description: "scratch child",
        },
      ],
    });

    const piWritten = await writePiSession(input, piHome);
    const fromPi = await readPiSession(piWritten.filePath);
    expect(fromPi.issues).toEqual([]);

    const claudeWritten = await writeClaudeSession(fromPi.session, claudeHome);
    const fromClaude = await readClaudeSession(claudeWritten.filePath);
    expect(fromClaude.issues).toEqual([]);
    expect(semanticParts(fromClaude.session)).toEqual(
      semanticParts(fromPi.session),
    );
    expect(fromClaude.session.children).toHaveLength(1);
    expect(semanticParts(fromClaude.session.children[0]!.session)).toEqual(
      semanticParts(fromPi.session.children[0]!.session),
    );
  });
});
