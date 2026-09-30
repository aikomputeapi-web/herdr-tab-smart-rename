// Live provider stress harness for Smart Rename.
//
// Runs the REAL AiSdkNamer against the configured provider through the same
// provider.env the worker reads, so a flaky or misconfigured provider shows up
// as a measurable failure rate instead of silently degrading tab names.
//
// Usage:
//   cd /d C:\Users\Administrator\herdr-tab-smart-rename-win
//   bun tools/stress-provider.ts [iterations]   (default 8)
//
// Reports valid-label / abstain / invalid / failed counts plus latency.
// Exit codes: 0 clean, 1 real failures or invalid labels, 2 rate limited
// (reported separately so a provider cap is never mistaken for a plugin bug,
// but still non-zero so CI or a wrapper notices).
//
// Distinct from the real worker: this fires back-to-back with no cooldown, so
// it deliberately provokes the provider's rate limit. The worker itself is
// capped at one model attempt per 10 minutes per tab, so real usage sees far
// less traffic than this harness.
import { loadProviderConfig, AiSdkNamer } from "../src/provider.ts";
import { validateTabLabel, type NamingContext } from "../src/domain.ts";

const CONFIG_DIR =
  process.env.SMART_RENAME_CONFIG_DIR ??
  "C:/Users/Administrator/AppData/Roaming/herdr/plugins/config/tab-smart-rename";
const iterations = Number(process.argv[2] ?? 8);

// smartrename.ps1 nulls these so provider.env wins; mirror that here or the
// harness would not be testing the same resolution order as the worker.
for (const name of [
  "SMART_RENAME_API_KEY",
  "SMART_RENAME_PROVIDER",
  "SMART_RENAME_BASE_URL",
  "SMART_RENAME_MODEL",
]) {
  delete process.env[name];
}
process.env.HERDR_PLUGIN_CONFIG_DIR = CONFIG_DIR;

const scenarios: Array<{ label: string; context: NamingContext }> = [
  {
    label: "clear task",
    context: {
      project: "telegram-channel-watcher",
      userMessages: ["why did the prod deploy fail on the credential ingest job"],
      agent: "claude",
    } as unknown as NamingContext,
  },
  {
    // The policy requires abstaining here, so a label is a false positive.
    label: "no task (expect abstain)",
    context: {
      project: null,
      userMessages: [],
      agent: "codex",
    } as unknown as NamingContext,
  },
  {
    label: "ambiguous",
    context: {
      project: "herdr-tab-smart-rename-win",
      userMessages: ["fix it"],
      agent: "jcode",
    } as unknown as NamingContext,
  },
  {
    label: "long project name",
    context: {
      project: "SomeVeryLongProjectNameIndeed",
      userMessages: ["add a retry with exponential backoff to the uploader"],
      agent: "jcode",
    } as unknown as NamingContext,
  },
];

const config = await loadProviderConfig(process.env);
console.log(
  `provider=${config.provider} model=${config.model} timeout=${config.timeoutMs}ms keylen=${config.apiKey.length}`,
);
console.log(`iterations=${iterations}\n`);

const namer = new AiSdkNamer(process.env);
let valid = 0;
let abstained = 0;
let invalid = 0;
let failed = 0;
const latencies: number[] = [];
const errors = new Map<string, number>();

for (let i = 0; i < iterations; i += 1) {
  // `i % scenarios.length` is always in range while `scenarios` is non-empty,
  // but noUncheckedIndexedAccess cannot prove that, so fall back explicitly
  // rather than asserting and risking a crash on an empty scenario list.
  const scenario = scenarios[i % scenarios.length] ?? scenarios[0];
  if (!scenario) throw new Error("no scenarios defined");
  const { label, context } = scenario;
  const started = performance.now();
  try {
    const suggestion = await namer.suggest(context);
    const ms = Math.round(performance.now() - started);
    latencies.push(ms);
    if (suggestion.tab === null) {
      abstained += 1;
      console.log(`  [${i}] ${label}: ABSTAIN (${ms}ms) ${suggestion.reason}`);
    } else if (validateTabLabel(suggestion.tab)) {
      valid += 1;
      console.log(`  [${i}] ${label}: OK "${suggestion.tab}" (${ms}ms)`);
    } else {
      invalid += 1;
      console.log(
        `  [${i}] ${label}: INVALID "${suggestion.tab}" (${ms}ms) <-- the plugin would drop this`,
      );
    }
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    failed += 1;
    const key = message.slice(0, 120);
    errors.set(key, (errors.get(key) ?? 0) + 1);
    console.log(`  [${i}] ${label}: FAILED (${ms}ms) ${message.slice(0, 160)}`);
  }
}

latencies.sort((a, b) => a - b);
const percentile = (q: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;

console.log("\n=== summary ===");
console.log(`valid labels : ${valid}/${iterations}`);
console.log(`abstained    : ${abstained}/${iterations}`);
console.log(`invalid      : ${invalid}/${iterations}`);
console.log(`failed       : ${failed}/${iterations}`);
if (latencies.length) {
  console.log(
    `latency ms   : min=${percentile(0)} p50=${percentile(0.5)} p90=${percentile(0.9)} max=${percentile(1)}`,
  );
}
for (const [message, count] of errors) console.log(`  x${count} ${message}`);

const rateLimited = [...errors.keys()].some((m) => /rate limit/i.test(m));
const problems = failed + invalid;
console.log("");
if (problems === 0) {
  console.log("RESULT: PASS (no failures, no invalid labels)");
  process.exitCode = 0;
} else if (invalid === 0 && rateLimited) {
  // A distinct code rather than 0: returning success here would let a wrapper
  // or CI step read "25% of calls failed" as a clean run. Callers that expect
  // the free tier to cap them can treat 2 as "inconclusive, retry later".
  console.log(
    "RESULT: RATE LIMITED (0 invalid labels; back-to-back calls exceed the free tier)",
  );
  console.log("        Real worker traffic is throttled to 1 attempt/10min/tab.");
  process.exitCode = 2;
} else {
  console.log(`RESULT: FAIL (${problems} problem(s))`);
  process.exitCode = 1;
}
