import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  acknowledgeRename,
  buildModelContext,
  emptyState,
  heuristicTitle,
  isDefaultLabel,
  markModelAttempt,
  markModelSuccess,
  markNamed,
  observeStableContext,
  prepareRename,
  reconcileItem,
  resetOwnership,
  shouldCallModel,
  shouldRenameAtChange,
  validateTabLabel,
  workspaceCandidate,
  isGenericWorkspaceName,
  titleCase,
  MAX_CONTEXT_CHARS,
  MODEL_RATE_MS,
  type NamingContext,
} from "../src/domain.ts";
import { sanitizeText } from "../src/text.ts";

test("ownership transitions preserve manual names and expected writes", () => {
  assert.equal(isDefaultLabel("12", 12), true);
  assert.equal(reconcileItem(undefined, "3", true).manual, false);
  assert.equal(reconcileItem(undefined, "Manual Task", false).manual, true);
  assert.equal(
    reconcileItem({ autoLabel: "Build API" }, "Manual Name").manual,
    true,
  );
  const prepared = prepareRename({}, "Fix Socket Reconnect");
  assert.deepEqual(acknowledgeRename(prepared, "Fix Socket Reconnect"), {
    autoLabel: "Fix Socket Reconnect",
    manual: false,
    observedLabel: "Fix Socket Reconnect",
  });
  assert.equal(acknowledgeRename(prepared, "My Name").manual, true);
  assert.deepEqual(resetOwnership({ manual: true, autoLabel: "Old" }), {
    manual: false,
  });
});

test("label, workspace, and process policy stays deterministic", () => {
  for (const [label, valid] of [
    ["Fix Socket Reconnect", true],
    ["Optimize VAR for Explainers", true],
    ["fix socket", false],
    ["One", false],
    ["This Label Has Far Too Many Words", false],
    ["Fix\nSocket", false],
  ] as const) {
    assert.equal(validateTabLabel(label), valid, label);
  }
  assert.equal(
    workspaceCandidate({ label: "var", number: 1 }, { cwd: "/code/other" }, "/code/other"),
    "VAR",
  );
  for (const [command, title] of [
    ["npm run dev", "Dev Server"],
    ["pytest -q", "Run Tests"],
    ["bun test", "Run Tests"],
    ["docker logs -f api", "View Logs"],
    ["ssh host", "Remote Shell"],
    ["zsh", null],
  ] as const) {
    assert.equal(heuristicTitle({ focusedPane: { process: { command } } }), title);
  }
});

test("title casing preserves acronyms instead of corrupting them", () => {
  // Known acronyms are upper-cased from any input casing.
  assert.equal(titleCase("var explainer"), "VAR Explainer");
  assert.equal(titleCase("api gateway"), "API Gateway");

  // Acronyms the model already capitalised must survive untouched, otherwise
  // repeated evaluation degrades a name ("YOLO" -> "Yolo") on every pass.
  assert.equal(titleCase("Enable YOLO Mode"), "Enable YOLO Mode");
  assert.equal(titleCase("Deploy AWS Stack"), "Deploy AWS Stack");
  assert.equal(titleCase("Fix SQL Query"), "Fix SQL Query");

  // Ordinary words are still normalised.
  assert.equal(titleCase("fix socket reconnect"), "Fix Socket Reconnect");
  assert.equal(titleCase("SHOUTING loudly"), "SHOUTING Loudly");
  assert.equal(titleCase("my-project_name"), "My Project Name");
});

test("generic workspace folders are detected so task names can replace them", () => {
  // Folders that say nothing about the project: every workspace under them
  // collapses to the same label, so the task name must win instead.
  for (const name of ["Coding", "coding", "  CODING  ", "Src", "Temp", "System32", ""]) {
    assert.equal(isGenericWorkspaceName(name), true, `expected generic: ${name}`);
  }

  // Real project names must keep their identity.
  for (const name of ["Any Auto Register", "Herdr", "Tradebot", "Paystub Generator"]) {
    assert.equal(isGenericWorkspaceName(name), false, `expected specific: ${name}`);
  }

  // A git worktree is always a meaningful identity, even if the folder is generic.
  assert.equal(isGenericWorkspaceName("Coding", true), false);
});

test("model context keeps weighted session evidence under the hard cap", () => {
  const huge = "x".repeat(20_000);
  const context = buildModelContext({
    workspaceName: huge,
    paneContexts: [
      {
        focused: true,
        label: "1",
        process: { name: huge, command: huge, cwd: huge },
        recentOutput: huge,
        sessionMessages: {
          origin: [huge],
          middle: [huge],
          recent: Array.from({ length: 4 }, () => huge),
        },
        userMessages: Array.from({ length: 6 }, () => huge),
      },
    ],
  });
  assert.ok(JSON.stringify(context).length <= MAX_CONTEXT_CHARS);
  assert.ok("sessionTimeline" in context);
  assert.deepEqual(Object.keys(context.sessionTimeline), ["origin", "middle", "recent"]);
  assert.equal("currentTab" in context, false);
});

test("text sanitization delegates ANSI and secret removal to libraries", () => {
  const input = [
    "\u001b[31msecret\u001b[0m",
    "Authorization: Bearer abc.def.ghi",
    'OPENAI_API_KEY="sk-abcdefghijklmnop"',
    "AWS_SECRET_ACCESS_KEY=verysecret",
    "https://user:password@example.com/path",
    "github_pat_abcdefghijklmnop",
    `sk-kimi-${"*".repeat(32)}tPJd`,
  ].join(" ");
  const output = sanitizeText(input, "");
  assert.doesNotMatch(
    output,
    /\u001b|abc\.def|verysecret|password@example|abcdefghijklmnop|tPJd/,
  );
  assert.match(output, /redacted/i);
});

test("a transcript spends a request only when the user says something new", () => {
  const state = emptyState();
  const context: NamingContext = {
    project: "Agents",
    userRequests: ["inspect logs"],
  };
  assert.equal(observeStableContext(state, "t1", context), false);
  assert.equal(observeStableContext(state, "t1", context), true);
  assert.equal(shouldCallModel(state, "t1", context, 1_000_000).allowed, true);

  // The cooldown exists to damp terminal redraw noise. A transcript changes
  // only when the user types, so waiting it out would leave a fresh request
  // unnamed for ten minutes and save nothing.
  markModelAttempt(state, "t1", 1_000_000);
  assert.equal(shouldCallModel(state, "t1", context, 1_000_001).allowed, true);

  markModelSuccess(state, "t1", context);
  assert.equal(
    shouldCallModel(state, "t1", context, 1_000_000 + MODEL_RATE_MS * 2).allowed,
    false,
  );

  const next: NamingContext = {
    project: "Agents",
    userRequests: ["inspect logs", "now ship it"],
  };
  assert.equal(shouldCallModel(state, "t1", next, 1_000_002).allowed, true);
});

test("a named tab re-checks on a widening interval, not every message", () => {
  const state = emptyState();
  const context = (n: number): NamingContext => ({
    project: "Agents",
    userRequests: [`message ${n}`],
  });

  // The first message has to spend a request: the tab has no label yet.
  assert.equal(shouldCallModel(state, "t1", context(1), 0).allowed, true);
  markModelSuccess(state, "t1", context(1));
  markNamed(state, "t1");

  const spent: number[] = [];
  for (let message = 2; message <= 32; message++) {
    const gate = shouldCallModel(state, "t1", context(message), message);
    if (!gate.allowed) continue;
    spent.push(message);
    markModelSuccess(state, "t1", context(message));
    markNamed(state, "t1");
  }

  // Thirty-one further messages cost four requests instead of thirty-one.
  assert.deepEqual(spent, [3, 7, 15, 31]);
});

test("backoff thresholds land on 1, 3, 7, 15, 31", () => {
  const hit = Array.from({ length: 32 }, (_, index) => index + 1).filter(
    shouldRenameAtChange,
  );
  assert.deepEqual(hit, [1, 3, 7, 15, 31]);
});

test("terminal context stays behind the model cooldown", () => {
  const state = emptyState();
  const context: NamingContext = {
    project: "Agents",
    focusedPane: { process: null, recentOutput: "working 1s" },
  };
  assert.equal(shouldCallModel(state, "t2", context, 1_000_000).allowed, true);
  markModelAttempt(state, "t2", 1_000_000);

  // A spinner rewrites itself every second, so without the cooldown this
  // context would look new on every sweep and spend a request each time.
  const redrawn: NamingContext = {
    project: "Agents",
    focusedPane: { process: null, recentOutput: "working 2s" },
  };
  assert.equal(shouldCallModel(state, "t2", redrawn, 1_000_001).allowed, false);
  assert.equal(
    shouldCallModel(state, "t2", redrawn, 1_000_000 + MODEL_RATE_MS + 1).allowed,
    true,
  );

  markModelSuccess(state, "t2", context);
  assert.equal(
    shouldCallModel(state, "t2", context, 1_000_000 + MODEL_RATE_MS * 2).allowed,
    false,
  );
});
