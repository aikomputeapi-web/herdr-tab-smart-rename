import { Database } from "bun:sqlite";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
   * A title the agent already computed for this session. Free — it costs no
   * model call — so it serves as the fallback when the namer declines or fails.
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
  "## 💡",
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
 * thing — all without loading a multi-megabyte file into memory.
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
 * answer. Sessions do not move, and a stale hit is re-validated by the open
 * that follows it.
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
 * instead — it is a UUID, so the first hit is the right one.
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
