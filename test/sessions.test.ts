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

test("jcode sidecar transcripts win over user-text-free journals", async () => {
  await withTempHome(async (home, env) => {
    const dir = path.join(home, ".jcode", "sessions");
    await mkdir(dir, { recursive: true });
    // Live verification found journals hold only tool traffic (user-role
    // turns are pure tool_result), while the .json sidecar is the real
    // transcript — the adapter must prefer it when both exist.
    await writeFile(
      path.join(dir, "session_raccoon_1758400000000_abc123.journal.jsonl"),
      lines(
        {
          append_messages: [
            { id: 1, role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
          ],
        },
      ),
    );
    const sidecar = {
      id: "s1",
      short_name: "raccoon",
      title: null,
      messages: [
        {
          id: "m1",
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>session scaffolding</system-reminder>" },
            { type: "text", text: "plan the garage shelving layout" },
          ],
        },
        {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "assistant narration" }],
        },
        {
          id: "m3",
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "tool output" }],
        },
      ],
    };
    await writeFile(
      path.join(dir, "session_raccoon_1758400000000_abc123.json"),
      JSON.stringify(sidecar),
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
    assert.ok(
      requests.includes("plan the garage shelving layout"),
      "sidecar prompt must reach the namer",
    );
    const serialized = JSON.stringify(digest.timeline);
    assert.ok(!serialized.includes("tool output"), "tool results must not leak");
    assert.ok(!serialized.includes("assistant narration"));
    assert.ok(!serialized.includes("session scaffolding"));
    assert.equal(digest.title, null);
  });
});

test("jcode .bak backups must not shadow the real transcript generation", async () => {
  await withTempHome(async (home, env) => {
    const dir = path.join(home, ".jcode", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session_camel_1758400000000_abc123.bak"),
      "not a transcript",
    );
    await writeFile(
      path.join(dir, "session_camel_1758400000000_abc123.json"),
      JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: "real camel prompt" }] },
        ],
      }),
    );

    const digest = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Camel" },
      env,
    );
    assert.ok(
      JSON.stringify(digest.timeline).includes("real camel prompt"),
      ".bak must not win the generation pick over the sidecar",
    );
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
      agent: "jcode",
      kind: "title",
      value: "Raccoon",
    });
    assert.deepEqual(jcodeTitleSession("🦧 jcode Orangutan"), {
      agent: "jcode",
      kind: "title",
      value: "Orangutan",
    });
    assert.deepEqual(
      jcodeTitleSession("🌐 jcode Monkey · +265 -7 · last ~9m43s"),
      { agent: "jcode", kind: "title", value: "Monkey" },
    );
    assert.equal(jcodeTitleSession("jcode - wake word check"), null);
    assert.equal(
      jcodeTitleSession(
        "🌐 Permanently fix herdr tab auto-renaming for jcod… · +72 -5 · work ~1h15m",
      ),
      null,
    );
    // Subject-form titles put the user's own prose after the name text; a
    // mid-sentence "jcode" is the user's vocabulary, not a session name.
    assert.equal(
      jcodeTitleSession(
        "🌐 Continue deeper validation of the jcode rename w… · +1080 -405",
      ),
      null,
      "mid-sentence jcode in a subject title must not be captured",
    );
    assert.equal(jcodeTitleSession("fix bug in jcode sessions adapter"), null);
    assert.equal(jcodeTitleSession("migrate jcode Monkey config"), null);
    assert.deepEqual(jcodeTitleSession("🌐 jcode Koala-2 · last ~3s"), {
      agent: "jcode",
      kind: "title",
      value: "Koala-2",
    });
    assert.equal(jcodeTitleSession("bun run dev -- watch mode"), null);
    // Live second format (wY Skunk tab, 2026-09-21): jcode titles the session
    // with a directory-model qualifier between "jcode" and the animal name.
    assert.deepEqual(
      jcodeTitleSession("🌐 jcode/meadow Skunk · +764 -139 · work ~1m32s"),
      { agent: "jcode", kind: "title", value: "Skunk" },
    );
    // The qualifier is optional and exactly one; two tokens is not a real
    // format, and a prose qualifier must stay rejected.
    assert.equal(jcodeTitleSession("🌐 jcode/meadow/redwood Skunk"), null);
    const digest = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Raccoon" },
      env,
    );
    assert.ok(
      JSON.stringify(digest.timeline).includes("audit the uploader retries"),
    );
  });
});

test("oversized, malformed, and journal-only jcode sessions degrade safely", async () => {
  await withTempHome(async (home, env) => {
    const sessions = path.join(home, ".jcode", "sessions");
    await mkdir(sessions, { recursive: true });

    // Oversized sidecar: skipped rather than read through a lossy window.
    await writeFile(
      path.join(sessions, "session_owl_1758300000000_aaaa.json"),
      JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: "too big to read" }] },
        ],
      }).padEnd(13 * 1024 * 1024, "x"),
    );
    // Malformed sidecar: parse failure must not throw out of the digest.
    await writeFile(
      path.join(sessions, "session_hawk_1758300000001_bbbb.json"),
      '{"messages": [truncated',
    );
    // Companion journal with real user text: fallback carries the prompt.
    await writeFile(
      path.join(sessions, "session_hawk_1758300000001_bbbb.journal.jsonl"),
      lines(
        {
          append_messages: [
            { id: 1, role: "user", content: [{ type: "text", text: "journal fallback prompt" }] },
          ],
        },
      ),
    );

    const oversized = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Owl" },
      env,
    );
    assert.deepEqual(oversized.timeline, { origin: [], middle: [], recent: [] });

    const fallback = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Hawk" },
      env,
    );
    assert.ok(
      JSON.stringify(fallback.timeline).includes("journal fallback prompt"),
      "journal fallback must still name the session",
    );
  });
});

test("a reused jcode session name resolves to the newest generation, not the cached one", async () => {
  await withTempHome(async (home, env) => {
    const dir = path.join(home, ".jcode", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session_raccoon_1758400000000_abc123.json"),
      JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: "topic alpha migration" }] },
        ],
      }),
    );
    await writeFile(
      path.join(dir, "session_raccoon_1758400000000_abc123.journal.jsonl"),
      lines({
        append_messages: [
          { id: 1, role: "user", content: [{ type: "text", text: "topic alpha journal" }] },
        ],
      }),
    );

    const first = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Raccoon" },
      env,
    );
    assert.ok(
      JSON.stringify(first.timeline).includes("topic alpha migration"),
    );

    // A brand-new session reuses the animal name with a later timestamp —
    // the worker must follow the newest files, not a cached old path.
    await writeFile(
      path.join(dir, "session_raccoon_1758400060000_def456.json"),
      JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: "topic beta rollout" }] },
        ],
      }),
    );
    await writeFile(
      path.join(dir, "session_raccoon_1758400060000_def456.journal.jsonl"),
      lines({
        append_messages: [
          { id: 1, role: "user", content: [{ type: "text", text: "topic beta journal" }] },
        ],
      }),
    );

    const second = await sessionDigest(
      { agent: "jcode", kind: "title", value: "Raccoon" },
      env,
    );
    assert.ok(
      JSON.stringify(second.timeline).includes("topic beta rollout"),
      "newest generation must win over the stale cached path",
    );
    assert.ok(
      !JSON.stringify(second.timeline).includes("topic alpha migration"),
      "dead generation must no longer be served",
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

const codexMeta = (cwd: string): unknown => ({
  type: "session_meta",
  payload: { cwd },
});

test("a codex pane without a session id is named from the rollout matching its cwd", async () => {
  await withTempHome(async (home, env) => {
    const id = "24242424-2424-4242-8242-242424242424";
    const dir = path.join(home, ".codex", "sessions", "2026", "09", "21");
    await mkdir(dir, { recursive: true });
    // Live-style rollout: meta first (recorded at session start), then the
    // user's first prompt.
    await writeFile(
      path.join(dir, `rollout-2026-09-21T05-00-00-${id}.jsonl`),
      lines(
        codexMeta("c:\\users\\administrator\\coding"),
        codexUser("# AGENTS.md instructions for c:\\users\\administrator\\coding"),
        codexUser("powershell lags when opening, why?"),
      ),
    );

    const digest = await sessionDigest(
      { agent: "codex", kind: "cwd", value: "c:\\users\\administrator\\coding" },
      env,
    );
    assert.ok(
      digest.timeline.origin.includes("powershell lags when opening, why?"),
      "the pane's real prompt must reach the namer via the cwd bridge",
    );
    // Agent scaffolding stays out.
    assert.ok(
      !JSON.stringify(digest.timeline).includes("AGENTS.md instructions"),
    );
  });
});

test("the codex cwd bridge prefers the newest rollout and never spans directories", async () => {
  await withTempHome(async (home, env) => {
    const mkdirp = (p: string) => mkdir(p, { recursive: true });
    const dayA = path.join(home, ".codex", "sessions", "2026", "09", "19");
    const dayB = path.join(home, ".codex", "sessions", "2026", "09", "21");
    await Promise.all([mkdirp(dayA), mkdirp(dayB)]);
    // Older rollout for the same cwd …
    await writeFile(
      path.join(dayA, "rollout-2026-09-19T09-00-00-19191919-1919-4191-8191-191919191919.jsonl"),
      lines(codexMeta("c:\\work\\app"), codexUser("older billing session")),
    );
    // … a newer different-project rollout (must not be matched to the pane) …
    await writeFile(
      path.join(dayB, "rollout-2026-09-21T04-00-00-21212121-2121-4212-8212-212121212121.jsonl"),
      lines(codexMeta("c:\\work\\other"), codexUser("unrelated project session")),
    );
    // … and the newest rollout for the pane's cwd, which must win.
    await writeFile(
      path.join(dayB, "rollout-2026-09-21T05-30-00-22222222-2222-4222-8222-222222222222.jsonl"),
      lines(codexMeta("c:\\work\\app"), codexUser("fix the reviewer loop")),
    );

    const digest = await sessionDigest(
      { agent: "codex", kind: "cwd", value: "C:\\Work\\APP" },
      env,
    );
    assert.deepEqual(digest.timeline.origin, ["fix the reviewer loop"]);
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
