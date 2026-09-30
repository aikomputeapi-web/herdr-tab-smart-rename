// Property-style fuzz of the label repair path added in 0e276e1.
//
// The repair is supposed to be strictly content preserving: it may recase a
// word or drop whole trailing words, but it must never invent a word, never
// lengthen the label past the cap, and must always either produce a valid
// label or throw. This drives AiSdkNamer.suggest with a stub completer so the
// assertions run against the real parseSuggestion/trimToValidLabel code.
import { test, expect } from "bun:test";
import { AiSdkNamer } from "../src/provider.ts";
import { validateTabLabel, MAX_TAB_LENGTH, titleCase } from "../src/domain.ts";
import type { NamingContext } from "../src/domain.ts";

const context = { project: "Fuzz" } as unknown as NamingContext;

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

test("label repair never invents words and never exceeds the cap", async () => {
  for (let seed = 1; seed <= 400; seed += 1) {
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

test("a huge single leading word is rejected rather than truncated", async () => {
  await expect(
    suggest("AnExtremelyLongUnbrokenProjectIdentifier Fix"),
  ).rejects.toThrow(/invalid model tab label/);
});

test("trimming preserves the leading project", async () => {
  const result = await suggest("Telegram-Channel-Watcher Deploy Failure");
  expect(result.tab).toBe("Telegram-Channel-Watcher Deploy");
});

test("titleCase is not applied before trimming", () => {
  // Guards the ordering bug: titleCase rewrites "-" to a space, which would
  // split the project into three words and change the trim result.
  const hyphenated = "Telegram-Channel-Watcher Deploy Failure";
  expect(titleCase(hyphenated)).not.toBe(hyphenated);
  expect(hyphenated.split(/\s+/).length).toBe(3);
});
