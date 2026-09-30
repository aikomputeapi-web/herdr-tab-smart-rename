// Property-style fuzz of the label repair path added in 0e276e1.
//
// The repair is supposed to be strictly content preserving: it may recase a
// word or drop whole trailing words, but it must never invent a word, never
// lengthen the label past the cap, and must always either produce a valid
// label or throw. This drives AiSdkNamer.suggest with a stub completer so the
// assertions run against the real parseSuggestion/trimToValidLabel code.
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AiSdkNamer } from "../src/provider.ts";
import { validateTabLabel, MAX_TAB_LENGTH, titleCase } from "../src/domain.ts";
import type { NamingContext } from "../src/domain.ts";

const context = { project: "Fuzz" } as unknown as NamingContext;

// suggest() deliberately re-reads provider.env and naming-prompt.md on every
// call so an edit applies without a restart (documented in the README). That
// is correct for production but costs ~60-90ms of disk I/O per call here, which
// is pure waste for a test that only cares about the label-repair path. Point
// the config dir at a real temp file once instead of letting 150 cases each
// re-read the user's actual config. The repair code under test is untouched:
// only the config/prompt lookup is short-circuited.
async function withFastConfig<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "repair-fuzz-"));
  try {
    await writeFile(
      path.join(dir, "provider.env"),
      "SMART_RENAME_PROVIDER=openai\nSMART_RENAME_BASE_URL=https://example.invalid/v1\nSMART_RENAME_MODEL=fuzz-model\nSMART_RENAME_API_KEY=fuzz-key\n",
    );
    await writeFile(path.join(dir, "naming-prompt.md"), "Name the task.\n");
    const previousConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
    try {
      return await fn();
    } finally {
      if (previousConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
      else process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDir;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function suggest(label: string) {
  const namer = new AiSdkNamer(
    { SMART_RENAME_API_KEY: "fuzz-key" },
    async () => JSON.stringify({ tab: label, reason: "fuzz" }),
  );
  return namer.suggest(context);
}

const WORD_ALPHABET = [
  "Telegram",
  "Channel",
  "Watcher",
  "Deploy",
  "Failure",
  "a",
  "1",
  "API",
  "OpenAI",
  "X",
  "VeryLongUnbrokenIdentifier",
  "a-b",
  "UPPER",
  "mIxEd",
];

function randomWord(rng: () => number): string {
  return WORD_ALPHABET[Math.floor(rng() * WORD_ALPHABET.length)] ?? "X";
}

// Deterministic LCG so a failure is always reproducible from the seed.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// Case count is a deliberate trade-off. suggest() re-reads provider.env and
// naming-prompt.md on every call by design (the README documents "config
// reloads before every model request" so an edit takes effect without a
// restart). withFastConfig points that reload at one temp config file instead
// of the user's real config dir, so the per-call I/O is near-free. 150 cases
// exercise every word in the alphabet across 150 deterministic seeds; before
// the fast-config bypass this took 8.8s, now it is bounded by the stub alone.
const CASES = 150;

// The budget is generous because a false pass is worse than a slow test: this
// measured 1.1s idle but 25s while the live worker and an 18-process
// concurrency storm were running, which turned a real pass into a timeout.
test("label repair never invents words and never exceeds the cap", async () => {
  await withFastConfig(async () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const rng = lcg(seed);
      const wordCount = 1 + Math.floor(rng() * 7);
      const words = Array.from({ length: wordCount }, () => randomWord(rng));
      const original = words.join(" ");

      let result: Awaited<ReturnType<typeof suggest>> | null = null;
      let threw = false;
      try {
        result = await suggest(original);
      } catch {
        threw = true;
      }

    if (threw) {
      // Rejecting is only legitimate when no shortening could have worked.
      // Verify by brute force that no valid prefix of the original exists.
      const originalWords = original.split(/\s+/).filter(Boolean);
      let salvageable = false;
      for (let count = originalWords.length; count >= 2; count -= 1) {
        if (validateTabLabel(originalWords.slice(0, count).join(" "))) {
          salvageable = true;
          break;
        }
      }
      if (salvageable) {
        throw new Error(
          `seed ${seed}: rejected "${original}" but a valid prefix exists`,
        );
      }
      continue;
    }

    const label = result!.tab;
    if (label === null) continue;

    expect(validateTabLabel(label), `seed ${seed}: "${label}" must be valid`).toBe(
      true,
    );
    expect(label.length, `seed ${seed}: must respect the cap`).toBeLessThanOrEqual(
      MAX_TAB_LENGTH,
    );

    // Content preservation: every surviving word must come from the original.
    // Case may change, and titleCase may split a hyphen, so compare on a
    // lowercase, hyphen-stripped basis.
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[-_]/g, "")
        .replace(/[^a-z0-9]/g, "");
    const originalChars = normalize(original);
    for (const word of label.split(/\s+/).filter(Boolean)) {
      const n = normalize(word);
      expect(
        originalChars.includes(n),
        `seed ${seed}: word "${word}" in "${label}" did not come from "${original}"`,
      ).toBe(true);
    }
    }
  });
}, 60_000);

test("a huge single leading word is rejected rather than truncated", async () => {
  await withFastConfig(() =>
    expect(
      suggest("AnExtremelyLongUnbrokenProjectIdentifier Fix"),
    ).rejects.toThrow(/invalid model tab label/),
  );
});

test("trimming preserves the leading project", async () => {
  await withFastConfig(async () => {
    const result = await suggest("Telegram-Channel-Watcher Deploy Failure");
    expect(result.tab).toBe("Telegram-Channel-Watcher Deploy");
  });
});

test("titleCase is not applied before trimming", () => {
  // Guards the ordering bug: titleCase rewrites "-" to a space, which would
  // split the project into three words and change the trim result.
  const hyphenated = "Telegram-Channel-Watcher Deploy Failure";
  expect(titleCase(hyphenated)).not.toBe(hyphenated);
  expect(hyphenated.split(/\s+/).length).toBe(3);
});
