import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentTitleLabel } from "../src/domain.ts";
import {
  hasSessionAdapter,
  jcodeTitleSession,
  sessionDigest,
} from "../src/sessions.ts";

const lines = (...entries: unknown[]): string =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const claudeUser = (text: string): unknown => ({
  type: "user",
  message: { role: "user", content: text },
});

const claudeToolResult = (): unknown => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
  },
});

const codexUser = (text: string): unknown => ({
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  },
});

async function withTempHome(
  run: (home: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "smart-rename-sessions-"));
  try {
    await run(home, { HOME: home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("jcode journals yield sampled user requests without scaffolding", async () => {
  await withTempHome(async (home, env) => {
    const dir = path.join(home, ".jcode", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session_raccoon_1758400000000_abc123.journal.jsonl"),
      lines(
        { meta: { short_name: "Raccoon", status: "active" } },
        {
          append_messages: [
            {
              id: 1,
              role: "user",
              content: [
                { type: "text", text: "<system-reminder>context scaffold</system-reminder>" },
                { type: "text", text: "split the billing module" },
              ],
            },
          ],
        },
        {
          append_messages: [
            { id: 2, role: "assistant", content: [{ type: "text", text: "assistant noise" }] },
          ],
        },
        {
          append_messages: [
            { id: 3, role: "user", content: [{ type: "text", text: "now cover it with a test" }] },
          ],
        },
      ),
    );

    const digest = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Raccoon" },
      env,
    );
    const requests = [
      ...digest.timeline.origin,
      ...digest.timeline.middle,
      ...digest.timeline.recent,
    ];
    assert.ok(requests.includes("split the billing module"));
    assert.ok(requests.includes("now cover it with a test"));
    assert.ok(
      !JSON.stringify(digest.timeline).includes("context scaffold"),
      "system-reminder scaffolding must not reach the namer",
    );
    assert.ok(!JSON.stringify(digest.timeline).includes("assistant noise"));
    assert.equal(digest.title, null);
    assert.equal(hasSessionAdapter("jcode"), true);
  });
});

test("jcode terminal titles bridge to the matching journal", async () => {
  await withTempHome(async (home, env) => {
    const dir = path.join(home, ".jcode", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session_raccoon_1758400000000_abc123.journal.jsonl"),
      lines(
        { meta: { short_name: "Raccoon" } },
        {
          append_messages: [
            { id: 1, role: "user", content: [{ type: "text", text: "audit the uploader retries" }] },
          ],
        },
      ),
    );

    assert.deepEqual(jcodeTitleSession("🌐 jcode Raccoon · last ~1m24s"), {
      kind: "title",
      value: "Raccoon",
    });
    assert.deepEqual(jcodeTitleSession("🌐 jcode Koala-2 · last ~3s"), {
      kind: "title",
      value: "Koala-2",
    });
    assert.equal(jcodeTitleSession("bun run dev -- watch mode"), null);
    const digest = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Raccoon" },
      env,
    );
    assert.ok(
      JSON.stringify(digest.timeline).includes("audit the uploader retries"),
    );
  });
});

test("unknown jcode sessions degrade quietly like the other adapters", async () => {
  await withTempHome(async (home, env) => {
    const dir = path.join(home, ".jcode", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session_owl_1758000000000_deadbeef.journal.jsonl"),
      lines(
        { meta: { short_name: "Owl" } },
        {
          append_messages: [
            { id: 1, role: "user", content: "string content still counts" },
          ],
        },
      ),
    );

    const missing = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Emu" },
      env,
    );
    assert.deepEqual(missing.timeline, { origin: [], middle: [], recent: [] });

    const found = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Owl" },
      env,
    );
    assert.ok(JSON.stringify(found.timeline).includes("string content still counts"));
  });
});

test("claude transcripts yield the user's own requests and title", async () => {
  await withTempHome(async (home, env) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const dir = path.join(home, ".claude", "projects", "C--work-app");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${id}.jsonl`),
      lines(
        claudeUser("<system-reminder>be nice</system-reminder>"),
        claudeUser("add retry to the uploader"),
        claudeToolResult(),
        { type: "ai-title", aiTitle: "Uploader retry work", sessionId: id },
        claudeUser("now cover it with a test"),
      ),
    );

    const digest = await sessionDigest(
      { agent: "claude", kind: "id", value: id },
      env,
    );
    assert.deepEqual(digest.timeline.origin, ["add retry to the uploader"]);
    // The sampler decides which section a request lands in; what matters here
    // is that it reaches the namer at all.
    const requests = [
      ...digest.timeline.origin,
      ...digest.timeline.middle,
      ...digest.timeline.recent,
    ];
    assert.ok(requests.includes("now cover it with a test"));
    // Agent scaffolding and tool results are not things the user asked for.
    assert.ok(
      !JSON.stringify(digest.timeline).includes("be nice"),
      "system reminders must not reach the namer",
    );
    assert.equal(digest.title, "Uploader retry work");
  });
});

test("codex rollouts are found by session id under the dated tree", async () => {
  await withTempHome(async (home, env) => {
    const id = "22222222-2222-4222-8222-222222222222";
    const dir = path.join(home, ".codex", "sessions", "2026", "08", "28");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `rollout-2026-08-28T05-16-06-${id}.jsonl`),
      lines(
        codexUser("# AGENTS.md instructions for C:\\work\\app"),
        codexUser("split the billing module"),
      ),
    );

    const digest = await sessionDigest(
      { agent: "codex", kind: "id", value: id },
      env,
    );
    assert.deepEqual(digest.timeline.origin, ["split the billing module"]);
    assert.equal(digest.title, null);
  });
});

test("a missing session and an unknown agent both degrade quietly", async () => {
  await withTempHome(async (_home, env) => {
    const missing = await sessionDigest(
      { agent: "claude", kind: "id", value: "33333333-3333-4333-8333-333333333333" },
      env,
    );
    assert.deepEqual(missing.timeline, { origin: [], middle: [], recent: [] });

    const unknown = await sessionDigest(
      { agent: "brand-new-cli", kind: "id", value: "abc" },
      env,
    );
    assert.deepEqual(unknown.timeline, { origin: [], middle: [], recent: [] });
    assert.equal(hasSessionAdapter("brand-new-cli"), false);
    assert.equal(hasSessionAdapter("opencode"), true);
  });
});

test("agent session titles condense into valid tab labels", () => {
  assert.equal(
    agentTitleLabel("Herdr version mismatch and worker stability"),
    "Herdr Version Mismatch",
  );
  assert.equal(
    agentTitleLabel("API arbitrage opportunities on RapidAPI"),
    "API Arbitrage Opportunities",
  );
  // Nothing usable is better than a bad label.
  assert.equal(agentTitleLabel(""), null);
  assert.equal(agentTitleLabel("untitled"), null);
});
