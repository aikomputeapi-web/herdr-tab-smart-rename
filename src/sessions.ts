import { Database } from "bun:sqlite";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import { type SessionTimeline } from "./domain.ts";
import { boundedText } from "./text.ts";

const SESSION_HEAD_BYTES = 64 * 1024;
const SESSION_MIDDLE_BYTES = 256 * 1024;
const SESSION_TAIL_BYTES = 512 * 1024;
const MESSAGE_LIMIT = 2_000;
const RECENT_LIMIT = 4;

/**
 * Where a pane's conversation lives, as reported by Herdr's snapshot. `kind` is
 * "path" for agents that hand out a transcript path (pi) and "id" for agents
 * that hand out an opaque session id (claude, codex, opencode); the adapter for
 * the agent knows how to turn an id into a transcript.
 */
export interface SessionRef {
  agent?: string | undefined;
  kind?: string | undefined;
  value?: string | undefined;
}

export interface SessionDigest {
  timeline: SessionTimeline;
  /**
   * A title the agent already computed for this session. Free â€” it costs no
   * model call â€” so it serves as the fallback when the namer declines or fails.
   */
  title: string | null;
}

export const EMPTY_TIMELINE: SessionTimeline = {
  origin: [],
  middle: [],
  recent: [],
};

export const EMPTY_DIGEST: SessionDigest = {
  timeline: EMPTY_TIMELINE,
  title: null,
};

export function isEmptyDigest(digest: SessionDigest): boolean {
  const { origin, middle, recent } = digest.timeline;
  return !origin.length && !middle.length && !recent.length;
}

/**
 * Agents write their own scaffolding into the transcript as `user` turns:
 * system reminders, skill bodies, AGENTS.md preambles, resume banners. Naming a
 * tab after that text gives every tab the same label, so keep only what the
 * person actually typed.
 */
const INJECTED_PREFIXES = [
  "<system-reminder",
  "<environment_context",
  "<user_instructions",
  "<command-name",
  "<command-message",
  "<local-command",
  "caveat: the messages below",
  "base directory for this skill:",
  "# agents.md instructions for",
  "this session is being continued from",
  "## ðŸ’¡",
];

function isInjected(text: string): boolean {
  const value = text.trimStart().toLowerCase();
  return INJECTED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function cleanMessage(text: unknown): string | null {
  const value = boundedText(text, MESSAGE_LIMIT);
  if (!value || isInjected(value)) return null;
  return value;
}

// ---------------------------------------------------------------------------
// JSONL transcripts (claude, codex, pi)
// ---------------------------------------------------------------------------

export type LineExtractor = (entry: unknown) => string | null;
export type TitleExtractor = (entry: unknown) => string | null;

interface OpenSession {
  handle: FileHandle;
  size: number;
}

/**
 * Opens a transcript only when it resolves inside `allowedRoot`, so a hostile
 * session value cannot walk the worker out to an arbitrary file.
 */
export async function openSessionFile(
  sessionPath: string | null,
  allowedRoot: string,
): Promise<OpenSession | null> {
  if (!sessionPath || !path.isAbsolute(sessionPath)) return null;

  let root: string;
  let resolved: string;
  try {
    [root, resolved] = await Promise.all([
      realpath(allowedRoot),
      realpath(sessionPath),
    ]);
  } catch {
    return null;
  }
  if (!resolved.startsWith(`${root}${path.sep}`)) return null;

  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) return null;
  const handle = await open(resolved, "r").catch(() => null);
  return handle ? { handle, size: info.size } : null;
}

async function readSessionWindow(
  handle: FileHandle,
  size: number,
  start: number,
  length: number,
): Promise<string> {
  const offset = Math.max(0, Math.min(start, size));
  const count = Math.max(0, Math.min(length, size - offset));
  const buffer = Buffer.alloc(count);
  const { bytesRead } = await handle.read(buffer, 0, count, offset);
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (offset > 0) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  if (offset + bytesRead < size) {
    const newline = text.lastIndexOf("\n");
    text = newline === -1 ? "" : text.slice(0, newline + 1);
  }
  return text;
}

function eachEntry(text: string, visit: (entry: unknown) => void): void {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // Ignore partial and non-JSON records; windows cut mid-file.
    }
  }
}

export function messagesFrom(text: string, extract: LineExtractor): string[] {
  const messages: string[] = [];
  eachEntry(text, (entry) => {
    const value = cleanMessage(extract(entry));
    if (value) messages.push(value);
  });
  return messages;
}

function titleFrom(text: string, extract: TitleExtractor): string | null {
  let title: string | null = null;
  eachEntry(text, (entry) => {
    const value = extract(entry);
    if (value) title = value;
  });
  return title;
}

/**
 * Samples the beginning, middle, and end of a transcript. The first request
 * says what the session set out to do, the last says what it is doing now, and
 * the middle keeps a long session from reading as if it only ever did one
 * thing â€” all without loading a multi-megabyte file into memory.
 */
export function buildTimeline(
  head: string[],
  middle: string[],
  recent: string[],
): SessionTimeline {
  const originMessage = head[0];
  const middleMessage = middle[Math.floor(middle.length / 2)];
  const seen = new Set([originMessage, middleMessage].filter(Boolean));
  return {
    origin: originMessage ? [originMessage] : [],
    middle:
      middleMessage && middleMessage !== originMessage ? [middleMessage] : [],
    recent: recent.filter((message) => !seen.has(message)).slice(-RECENT_LIMIT),
  };
}

export async function sampleJsonlSession(
  sessionPath: string | null,
  allowedRoot: string,
  extract: LineExtractor,
  extractTitle?: TitleExtractor,
): Promise<SessionDigest> {
  const session = await openSessionFile(sessionPath, allowedRoot);
  if (!session) return EMPTY_DIGEST;
  try {
    const middleStart = Math.max(
      0,
      Math.floor((session.size - SESSION_MIDDLE_BYTES) / 2),
    );
    const tailStart = Math.max(0, session.size - SESSION_TAIL_BYTES);
    const [headText, middleText, tailText] = await Promise.all([
      readSessionWindow(session.handle, session.size, 0, SESSION_HEAD_BYTES),
      readSessionWindow(
        session.handle,
        session.size,
        middleStart,
        SESSION_MIDDLE_BYTES,
      ),
      readSessionWindow(
        session.handle,
        session.size,
        tailStart,
        SESSION_TAIL_BYTES,
      ),
    ]);
    return {
      timeline: buildTimeline(
        messagesFrom(headText, extract),
        messagesFrom(middleText, extract),
        messagesFrom(tailText, extract),
      ),
      title: extractTitle
        ? boundedText(titleFrom(tailText, extractTitle), 120) || null
        : null,
    };
  } finally {
    await session.handle.close();
  }
}

// ---------------------------------------------------------------------------
// Per-agent line shapes
// ---------------------------------------------------------------------------

const TextPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

const ClaudeLineSchema = z.looseObject({
  type: z.literal("user"),
  isMeta: z.boolean().optional(),
  message: z.looseObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(TextPartSchema)]),
  }),
});

const ClaudeTitleSchema = z.looseObject({
  type: z.literal("ai-title"),
  aiTitle: z.string(),
});

const CodexLineSchema = z.looseObject({
  payload: z.looseObject({
    type: z.literal("message"),
    role: z.literal("user"),
    content: z.union([z.string(), z.array(TextPartSchema)]),
  }),
});

const PiLineSchema = z.looseObject({
  type: z.literal("message"),
  message: z.looseObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(TextPartSchema)]),
  }),
});

const TEXT_PART_TYPES = new Set(["text", "input_text"]);

function contentText(
  content: string | z.infer<typeof TextPartSchema>[],
): string | null {
  if (typeof content === "string") return content;
  // A turn made only of tool results is the agent talking to itself, not a
  // request; skip it rather than contributing an empty string to the timeline.
  const parts = content.filter((part) => TEXT_PART_TYPES.has(part.type));
  if (!parts.length) return null;
  return parts
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join(" ");
}

export const claudeExtractor: LineExtractor = (entry) => {
  const parsed = ClaudeLineSchema.safeParse(entry);
  if (!parsed.success || parsed.data.isMeta) return null;
  return contentText(parsed.data.message.content);
};

export const claudeTitleExtractor: TitleExtractor = (entry) => {
  const parsed = ClaudeTitleSchema.safeParse(entry);
  return parsed.success ? parsed.data.aiTitle : null;
};

export const codexExtractor: LineExtractor = (entry) => {
  const parsed = CodexLineSchema.safeParse(entry);
  return parsed.success ? contentText(parsed.data.payload.content) : null;
};

export const piExtractor: LineExtractor = (entry) => {
  const parsed = PiLineSchema.safeParse(entry);
  return parsed.success ? contentText(parsed.data.message.content) : null;
};

// ---------------------------------------------------------------------------
// Locating a transcript from an opaque session id
// ---------------------------------------------------------------------------

/**
 * Resolving an id to a file means scanning a directory tree, so remember the
 * answer. Id-keyed sessions are immutable â€” a new session gets a new id â€” so
 * a cached path stays correct for the id's lifetime; existence is re-checked
 * on every hit. Title-keyed lookups (jcode) must NOT use this cache: the
 * agent reuses animal names, so a newer session for the same name would be
 * shadowed by the stale path (verified live-style in test with two
 * generations of "raccoon").
 */
const locationCache = new Map<string, string>();

async function cachedLocate(
  key: string,
  find: () => Promise<string | null>,
): Promise<string | null> {
  const hit = locationCache.get(key);
  if (hit && (await stat(hit).catch(() => null))) return hit;
  if (hit) locationCache.delete(key);
  const found = await find();
  if (found) locationCache.set(key, found);
  return found;
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

function jcodeSessionsRoot(env: NodeJS.ProcessEnv): string {
  return path.join(home(env), ".jcode", "sessions");
}

function claudeRoot(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home(env), ".claude");
}

function codexRoot(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(home(env), ".codex");
}

function piRoot(env: NodeJS.ProcessEnv): string {
  const agentDir =
    env.PI_CODING_AGENT_DIR || path.join(home(env), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

async function subdirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
}

/**
 * Claude Code files a session under a slug of its cwd. Deriving that slug means
 * matching Claude's own escaping rules against a cwd Herdr reports with
 * different casing, so search the project directories for the session id
 * instead â€” it is a UUID, so the first hit is the right one.
 */
async function locateClaudeSession(
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const projects = path.join(claudeRoot(env), "projects");
  for (const slug of await subdirectories(projects)) {
    const candidate = path.join(projects, slug, `${id}.jsonl`);
    if (await stat(candidate).catch(() => null)) return candidate;
  }
  return null;
}

/**
 * Codex partitions rollouts by date, so walk newest-first: the session being
 * named is nearly always today's, which makes this a single directory read.
 */
async function locateCodexSession(
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const root = path.join(codexRoot(env), "sessions");
  const descending = (values: string[]): string[] =>
    [...values].sort().reverse();
  for (const year of descending(await subdirectories(root))) {
    const yearDir = path.join(root, year);
    for (const month of descending(await subdirectories(yearDir))) {
      const monthDir = path.join(yearDir, month);
      for (const day of descending(await subdirectories(monthDir))) {
        const dayDir = path.join(monthDir, day);
        const files = await readdir(dayDir).catch(() => []);
        const match = files.find((name) => name.endsWith(`-${id}.jsonl`));
        if (match) return path.join(dayDir, match);
      }
    }
  }
  return null;
}

const CodexMetaSchema = z.looseObject({
  type: z.literal("session_meta"),
  payload: z.looseObject({
    cwd: z.string(),
  }),
});

async function codexRolloutCwd(
  file: string,
): Promise<string | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    // session_meta is the first record, so the head window is enough and the
    // live file never has to be read end-to-end.
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const rawLine of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const parsed = CodexMetaSchema.safeParse(JSON.parse(rawLine));
        if (parsed.success) return parsed.data.payload.cwd;
      } catch {
        // Partial or non-JSON line; keep scanning.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Codex panes that herdr detected before the first prompt carry no session id,
 * and unlike jcode their terminal title carries no animal name. The rollout
 * written at session start records the working directory, so the newest
 * rollout whose cwd matches the pane's is the conversation to sample. Id-keyed
 * lookups stay cached because ids are unique; cwd matches must not be â€” a
 * directory can host back-to-back sessions, and the pane always means the
 * newest one.
 */
async function locateCodexSessionByCwd(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const root = path.join(codexRoot(env), "sessions");
  // Walk newest-first and limit how deep a pathological tree can stall a sweep.
  const dateDirs: string[] = [];
  for (const year of [...(await subdirectories(root))].sort().reverse()) {
    const yearDir = path.join(root, year);
    for (const month of [...(await subdirectories(yearDir))].sort().reverse()) {
      const monthDir = path.join(yearDir, month);
      for (const day of [...(await subdirectories(monthDir))].sort().reverse()) {
        dateDirs.push(path.join(monthDir, day));
        if (dateDirs.length >= 14) break;
      }
      if (dateDirs.length >= 14) break;
    }
    if (dateDirs.length >= 14) break;
  }
  for (const dayDir of dateDirs) {
    const files = await readdir(dayDir).catch(() => []);
    for (const name of [...files].sort().reverse()) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dayDir, name);
      if (sameCwd((await codexRolloutCwd(file)) ?? undefined, cwd)) return file;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Journal transcripts (jcode)
// ---------------------------------------------------------------------------

/**
 * jcode keeps two session files under `~/.jcode/sessions`:
 *
 * - `session_<name>_<ts>_<hash>.json` â€” the real transcript, one JSON object
 *   with a `messages` array of user/assistant turns.
 * - `session_<name>_<ts>_<hash>.journal.jsonl` â€” a side journal of tool calls
 *   and reasoning. Long line records mean the shared byte-window sampler
 *   would slice JSON mid-object, and every line rewrites the session meta,
 *   so whole-line sampling is the only faithful read.
 *
 * Every live journal sampled during verification carried zero user text â€”
 * all user-role content was tool_result parts â€” so the sidecar is the
 * primary source and the journal only a fallback for sessions without one.
 */
const JCODE_READ_LINE_CAP = 2_000;
const JCODE_SIDECAR_MAX_BYTES = 12 * 1024 * 1024;

const JcodeUserLineSchema = z.looseObject({
  append_messages: z
    .array(
      z.looseObject({
        // Assistant turns narrate what already happened; the namer wants what
        // the user asked for, so anything else is discarded here.
        role: z.literal("user"),
        content: z.union([z.string(), z.array(TextPartSchema)]),
      }),
    )
    .optional(),
});

const JcodeSidecarSchema = z.looseObject({
  messages: z
    .array(
      z.looseObject({
        // Roles are filtered during extraction: journal-side user turns can
        // be pure tool_result plumbing, so rejecting the parse on role shape
        // would throw away the whole transcript over one malformed turn.
        role: z.string(),
        content: z.union([z.string(), z.array(TextPartSchema)]),
      }),
    )
    .catch([]),
});

/**
 * jcode writes user turns whose content array often leads with a session-context
 * system reminder followed by the real prompt. Cleaning parts individually keeps
 * the reminder out while the user's own words survive; joining like the other
 * extractors would smear the reminder prefix over the request and trip the
 * injected-scaffolding filter.
 */
function jcodeCollectMessages(
  messages: ReadonlyArray<{
    role: string;
    content: string | ReadonlyArray<{ type: string; text?: string | undefined }>;
  }>,
): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      const cleaned = cleanMessage(message.content);
      if (cleaned) out.push(cleaned);
      continue;
    }
    for (const part of message.content) {
      if (!TEXT_PART_TYPES.has(part.type) || !part.text) continue;
      const cleaned = cleanMessage(part.text);
      if (cleaned) out.push(cleaned);
    }
  }
  return out;
}

function jcodeLineMessages(entry: unknown): string[] {
  const parsed = JcodeUserLineSchema.safeParse(entry);
  if (!parsed.success || !parsed.data.append_messages) return [];
  return jcodeCollectMessages(parsed.data.append_messages);
}

async function* jcodeLines(
  handle: FileHandle,
  size: number,
): AsyncGenerator<string> {
  const CHUNK = 256 * 1024;
  // A chunk boundary can split a multibyte UTF-8 sequence; stream decoding
  // carries the partial sequence into the next chunk instead of mangling it.
  const decoder = new TextDecoder("utf8");
  let offset = 0;
  let carry = "";
  let emitted = 0;
  while (offset < size && emitted < JCODE_READ_LINE_CAP) {
    const count = Math.min(CHUNK, size - offset);
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    let index = carry.indexOf("\n");
    while (index !== -1) {
      yield carry.slice(0, index);
      emitted += 1;
      carry = carry.slice(index + 1);
      if (emitted >= JCODE_READ_LINE_CAP) return;
      index = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  if (emitted < JCODE_READ_LINE_CAP && carry.trim()) yield carry;
}

async function jcodeSidecarDigest(
  sessionFile: string,
  env: NodeJS.ProcessEnv,
): Promise<SessionDigest> {
  const session = await openSessionFile(sessionFile, jcodeSessionsRoot(env));
  if (!session) return EMPTY_DIGEST;
  if (session.size > JCODE_SIDECAR_MAX_BYTES) {
    await session.handle.close();
    // Partial JSON cannot be parsed, so oversized transcripts are skipped
    // rather than read through a lossy window.
    return EMPTY_DIGEST;
  }
  try {
    const buffer = Buffer.alloc(session.size);
    let offset = 0;
    while (offset < session.size) {
      const { bytesRead } = await session.handle.read(
        buffer,
        offset,
        session.size - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const parsed = JcodeSidecarSchema.safeParse(
      JSON.parse(buffer.subarray(0, offset).toString("utf8")),
    );
    if (!parsed.success) return EMPTY_DIGEST;
    const messages = jcodeCollectMessages(parsed.data.messages);
    if (!messages.length) return EMPTY_DIGEST;
    return {
      timeline: buildTimeline(messages, messages, messages),
      // The sidecar `title` field was null in every live session sampled, so
      // no free fallback title is claimed for this adapter.
      title: null,
    };
  } catch {
    return EMPTY_DIGEST;
  } finally {
    await session.handle.close();
  }
}

export async function jcodeTranscriptDigest(
  sessionFile: string | null,
  env: NodeJS.ProcessEnv,
): Promise<SessionDigest> {
  if (!sessionFile) return EMPTY_DIGEST;
  // The sidecar carries the real conversation; journals only mirror tool
  // traffic, so they are a last resort.
  if (sessionFile.endsWith(".json")) {
    return jcodeSidecarDigest(sessionFile, env);
  }
  const session = await openSessionFile(sessionFile, jcodeSessionsRoot(env));
  if (!session) return EMPTY_DIGEST;
  try {
    const messages: string[] = [];
    for await (const raw of jcodeLines(session.handle, session.size)) {
      if (!raw.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      messages.push(...jcodeLineMessages(entry));
    }
    if (!messages.length) return EMPTY_DIGEST;
    return {
      timeline: buildTimeline(messages, messages, messages),
      title: null,
    };
  } finally {
    await session.handle.close();
  }
}

/**
 * jcode publishes its session's short name in the terminal title
 * ("ðŸŒ jcode Raccoon Â· last ~1m24s"). Herdr cannot identify the jcode
 * process as an agent, so this title is the only clue which journal belongs
 * to a pane. Live snapshots show three shapes: the activity suffix
 * ("jcode Raccoon Â· last ~1m24s"), diff stats before it
 * ("jcode Monkey Â· +265 -7 Â· last ~9m43s"), and idle panes that drop the
 * suffix entirely ("ðŸ¦§ jcode Orangutan").
 *
 * When jcode instead shows the conversation subject ("ðŸŒ Permanently fix
 * herdr tab auto-renamingâ€¦ Â· +72 -5 Â· work ~1h15m"), the animal name is not
 * in the title at all, and the word "jcode" appearing anywhere else
 * ("â€¦ of the jcode rename wâ€¦") is the user's own vocabulary. Anchoring at
 * the title start (allowing only an emoji/symbol prefix) is what separates
 * the two: a match anywhere else is a false capture that resolves to no
 * session â€” verified live against the real herdr snapshot.
 *
 * The ref carries `agent: "jcode"` so it routes to the jcode adapter on its
 * own â€” herdr.ts bridges it verbatim, and a ref without an agent silently
 * falls out of every adapter (a live regression this return shape once
 * caused).
 */
const JCODE_TITLE_PATTERN =
  /^[\p{Extended_Pictographic}\u2190-\u21FF\u2500-\u27BF\u2B00-\u2BFF\uFE0F\u200D\s]*jcode\s+([A-Za-z][A-Za-z0-9_-]{1,24})(?=\s|$)/u;

export function jcodeTitleSession(
  title: string | null | undefined,
): { agent: string; kind: string; value: string } | null {
  if (!title) return null;
  const match = JCODE_TITLE_PATTERN.exec(stripAnsi(title));
  if (!match) return null;
  return { agent: "jcode", kind: "title", value: match[1]! };
}

/**
 * jcode writes transcript pairs (`<stem>.json` sidecar + `<stem>.journal.jsonl`)
 * with identical stems for one session, and reuses animal names across
 * generations. Resolve the newest generation, then return its files in
 * preference order (sidecar, journal) so the adapter can fall back when a
 * file exists but cannot be read usefully â€” an old session's malformed
 * sidecar must still let its own readable journal name the pane, and a
 * broken newest generation must never drag in an older one. Sorting by full
 * name works because the creation timestamp sits between the name and the
 * hash.
 */
async function locateJcodeTranscript(
  shortName: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const root = jcodeSessionsRoot(env);
  // Titles show "Raccoon" while journals name files `session_raccoon_<ts>`,
  // so the match must ignore case (a real FS would too on Windows). Only the
  // two transcript extensions count: jcode also drops `.bak` backups whose
  // otherwise-identical names sort last and would shadow the real generation
  // (live data had `session_camel_..._.bak` beating `session_camel_..._.json`).
  const pattern = `_${shortName.toLowerCase()}_`;
  const names = (await readdir(root).catch(() => [] as string[])).filter(
    (name) =>
      name.startsWith("session_") &&
      name.toLowerCase().includes(pattern) &&
      (name.endsWith(".json") || name.endsWith(".journal.jsonl")),
  );
  const generations = new Map<string, { sidecar?: string; journal?: string }>();
  for (const name of names) {
    const stem = name.replace(/\.journal\.jsonl$/, "").replace(/\.json$/, "");
    const entry = generations.get(stem) ?? {};
    if (name.endsWith(".json")) entry.sidecar = name;
    else if (name.endsWith(".journal.jsonl")) entry.journal = name;
    generations.set(stem, entry);
  }
  const newestStem = [...generations.keys()].sort().at(-1);
  if (!newestStem) return [];
  const newest = generations.get(newestStem)!;
  return [newest.sidecar, newest.journal]
    .filter((name): name is string => Boolean(name))
    .map((name) => path.join(root, name));
}

// ---------------------------------------------------------------------------
// SQLite transcripts (opencode and its forks)
// ---------------------------------------------------------------------------

interface SqliteStore {
  /** Directory under the data root, e.g. `opencode`. */
  directory: string;
  /** Database file inside it, e.g. `opencode.db`. */
  file: string;
}

const SQLITE_STORES: Record<string, SqliteStore> = {
  opencode: { directory: "opencode", file: "opencode.db" },
  kilo: { directory: "kilo", file: "kilo.db" },
};

function dataRoot(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME || path.join(home(env), ".local", "share");
}

const USER_PARTS_SQL = `
  select p.data as data
  from part p
  join message m on m.id = p.message_id
  where m.session_id = ?1
    and json_extract(m.data, '$.role') = 'user'
  order by m.time_created, p.time_created
  limit 400
`;

/**
 * Reads an opencode-style store. The database is the live one the agent is
 * writing to, so open it read-only: WAL lets us read without blocking writers,
 * and read-only guarantees a bug here can never corrupt a session.
 */
async function sqliteDigest(
  store: SqliteStore,
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<SessionDigest> {
  const file = path.join(dataRoot(env), store.directory, store.file);
  if (!(await stat(file).catch(() => null))) return EMPTY_DIGEST;

  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    const rows = db.query(USER_PARTS_SQL).all(id) as { data: string }[];
    const messages: string[] = [];
    for (const row of rows) {
      let part: unknown;
      try {
        part = JSON.parse(row.data);
      } catch {
        continue;
      }
      const parsed = TextPartSchema.safeParse(part);
      if (!parsed.success || !TEXT_PART_TYPES.has(parsed.data.type)) continue;
      const value = cleanMessage(parsed.data.text);
      if (value) messages.push(value);
    }
    const titleRow = db
      .query("select title from session where id = ?1")
      .get(id) as { title?: string } | null;
    return {
      timeline: buildTimeline(messages, messages, messages),
      title: boundedText(titleRow?.title, 120) || null,
    };
  } catch {
    return EMPTY_DIGEST;
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

type Adapter = (
  ref: SessionRef,
  env: NodeJS.ProcessEnv,
) => Promise<SessionDigest>;

/**
 * One entry per agent CLI. Adding an agent is adding a row here plus, if it
 * stores transcripts in a shape nothing else uses, an extractor above.
 */
const ADAPTERS: Record<string, Adapter> = {
  jcode: async (ref, env) => {
    // Herdr never identifies jcode as a pane agent and hands out no session
    // ref; herdr.ts bridges one from the terminal title instead. The lookup
    // is keyed by a reusable animal name, so it is intentionally uncached â€”
    // a cached path would keep feeding a dead session once the agent rolls
    // the same name into a new one (regression covered in tests). Candidates
    // arrive newest-generation-first; the first file that actually yields
    // user text wins, so a malformed sidecar falls through to its journal.
    if (ref.kind !== "title" || !ref.value) return EMPTY_DIGEST;
    for (const file of await locateJcodeTranscript(ref.value, env)) {
      const digest = await jcodeTranscriptDigest(file, env);
      if (!isEmptyDigest(digest)) return digest;
    }
    return EMPTY_DIGEST;
  },
  claude: async (ref, env) => {
    if (ref.kind !== "id" || !ref.value) return EMPTY_DIGEST;
    const file = await cachedLocate(`claude:${ref.value}`, () =>
      locateClaudeSession(ref.value!, env),
    );
    return sampleJsonlSession(
      file,
      path.join(claudeRoot(env), "projects"),
      claudeExtractor,
      claudeTitleExtractor,
    );
  },
  codex: async (ref, env) => {
    if (ref.kind === "cwd" && ref.value) {
      // No id and no title clue: herdr saw codex before its first prompt. The
      // newest rollout matching the pane's cwd is the live conversation.
      const file = await locateCodexSessionByCwd(ref.value, env);
      return sampleJsonlSession(
        file,
        path.join(codexRoot(env), "sessions"),
        codexExtractor,
      );
    }
    if (ref.kind !== "id" || !ref.value) return EMPTY_DIGEST;
    const file = await cachedLocate(`codex:${ref.value}`, () =>
      locateCodexSession(ref.value!, env),
    );
    return sampleJsonlSession(
      file,
      path.join(codexRoot(env), "sessions"),
      codexExtractor,
    );
  },
  pi: async (ref, env) => {
    if (ref.kind !== "path" || !ref.value) return EMPTY_DIGEST;
    return sampleJsonlSession(ref.value, piRoot(env), piExtractor);
  },
  opencode: (ref, env) =>
    ref.value
      ? sqliteDigest(SQLITE_STORES.opencode!, ref.value, env)
      : Promise.resolve(EMPTY_DIGEST),
  kilo: (ref, env) =>
    ref.value
      ? sqliteDigest(SQLITE_STORES.kilo!, ref.value, env)
      : Promise.resolve(EMPTY_DIGEST),
};

export function hasSessionAdapter(agent: unknown): boolean {
  return Boolean(ADAPTERS[String(agent ?? "").toLowerCase()]);
}

/**
 * Reads whatever the agent running in a pane has written about the session so
 * far. Unknown agents return an empty digest and the caller falls back to
 * terminal output, so a new CLI degrades instead of breaking.
 */
export async function sessionDigest(
  ref: SessionRef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionDigest> {
  const adapter = ADAPTERS[String(ref.agent ?? "").toLowerCase()];
  if (!adapter) return EMPTY_DIGEST;
  try {
    return await adapter(ref, env);
  } catch {
    return EMPTY_DIGEST;
  }
}
