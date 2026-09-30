// Profiles where the repair fuzz spends its time. 400 cases with a stubbed
// completer should be milliseconds; if it is seconds, something in the
// suggest() path is doing real work per call.
import { AiSdkNamer } from "../src/provider.ts";
import { loadProviderConfig, loadNamingPrompt } from "../src/provider.ts";
import { sanitizeText } from "../src/text.ts";
import { validateTabLabel } from "../src/domain.ts";
import type { NamingContext } from "../src/domain.ts";

const context = { project: "Fuzz" } as unknown as NamingContext;
const env = { SMART_RENAME_API_KEY: "fuzz-key" } as NodeJS.ProcessEnv;
const N = 100;

async function time(label: string, fn: () => Promise<unknown> | unknown) {
  const t0 = performance.now();
  for (let i = 0; i < N; i += 1) await fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms / ${N}`);
  return ms;
}

console.log(`per-call cost over ${N} iterations\n`);

await time("loadProviderConfig", () => loadProviderConfig(env));
const config = await loadProviderConfig(env);
await time("loadNamingPrompt", () => loadNamingPrompt(config, env));
await time("sanitizeText", () => sanitizeText("Telegram Channel Watcher Deploy"));
await time("validateTabLabel", () => validateTabLabel("Telegram Channel Watcher Deploy"));
await time("new AiSdkNamer", () => new AiSdkNamer(env, async () => "{}"));
await time("suggest (stub completer)", () =>
  new AiSdkNamer(env, async () =>
    JSON.stringify({ tab: "Telegram Channel Watcher Deploy", reason: "fuzz" }),
  ).suggest(context),
);

console.log(
  "\nIf suggest() dominates and loadProviderConfig is small, the cost is in the\n" +
    "AI SDK module load or in the env/config resolution per call.",
);
