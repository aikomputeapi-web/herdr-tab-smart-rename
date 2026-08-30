import { createHash } from "node:crypto";
import path from "node:path";
import { boundedText, sanitizeText } from "./text.ts";

export interface OwnershipRecord {
  manual?: boolean | undefined;
  autoLabel?: string | undefined;
  expectedLabel?: string | undefined;
  observedLabel?: string | undefined;
}

export interface SmartRenameState {
  version: 1;
  workspaces: Record<string, OwnershipRecord>;
  tabs: Record<string, OwnershipRecord>;
  modelAttempts: Record<string, number>;
  fingerprints: Record<string, string>;
  pendingFingerprints: Record<string, string>;
  /** Distinct contexts seen per tab; the backoff counts these, not sweeps. */
  contextChanges?: Record<string, number> | undefined;
  /** Value of contextChanges when the tab last earned a label. */
  namedAt?: Record<string, number> | undefined;
  [key: string]: unknown;
}

export interface ProcessInfo {
  name: string;
  command: string;
  cwd: string;
}

export interface SessionTimeline {
  origin: string[];
  middle: string[];
  recent: string[];
}

export interface PaneContext {
  focused: boolean;
  label: string;
  process: ProcessInfo | null;
  recentOutput: string;
  userMessages: string[];
  sessionMessages?: SessionTimeline;
  /** Title the agent already computed for its own session, if it exposes one. */
  sessionTitle?: string | null;
}

interface ProcessEvidence {
  process: ProcessInfo | null;
  recentOutput: string;
}

interface SiblingEvidence {
  label: string;
  process: ProcessInfo | null;
}

export type NamingContext =
  | { project?: string | undefined; sessionTimeline: SessionTimeline }
  | { project?: string | undefined; userRequests: string[] }
  | {
      project?: string | undefined;
      focusedPane: ProcessEvidence;
      siblingPanes?: SiblingEvidence[];
    };

export interface NameSuggestion {
  tab: string | null;
  reason: string;
}

export interface RenameChange {
  kind: "workspace" | "tab";
  id: string;
  from: string;
  to: string;
}

export interface RenameResult {
  dryRun: boolean;
  workspace: string;
  tab: string;
  candidate: { workspace: string | null; tab: string | null };
  reason: string;
  usedModel: boolean;
  ownership: { workspaceManual: boolean; tabManual: boolean };
  changes: RenameChange[];
}

export const MAX_TAB_LENGTH = 34;
export const MAX_CONTEXT_CHARS = 4_500;
export const MODEL_RATE_MS = 10 * 60 * 1_000;

export function emptyState(): SmartRenameState {
  return {
    version: 1,
    workspaces: {},
    tabs: {},
    modelAttempts: {},
    fingerprints: {},
    pendingFingerprints: {},
  };
}

export function isDefaultLabel(label: unknown, number?: unknown): boolean {
  const value = String(label ?? "").trim();
  return !value || /^\d+$/.test(value) || value === String(number ?? "");
}

export function reconcileItem(
  record: OwnershipRecord | undefined,
  currentLabel: string,
  eligible = false,
): OwnershipRecord {
  const next = { ...record };
  const previousObserved = next.observedLabel;
  if (next.expectedLabel) {
    if (currentLabel === next.expectedLabel) {
      next.autoLabel = currentLabel;
      delete next.expectedLabel;
      next.manual = false;
    } else {
      delete next.expectedLabel;
      next.manual = true;
    }
  } else if (next.autoLabel && currentLabel !== next.autoLabel) {
    next.manual = true;
  } else if (
    record &&
    previousObserved !== undefined &&
    currentLabel !== previousObserved
  ) {
    next.manual = true;
  } else if (!record) {
    next.manual = !eligible;
  }
  next.observedLabel = currentLabel;
  return next;
}

export function acknowledgeRename(
  record: OwnershipRecord | undefined,
  label: string,
): OwnershipRecord {
  const next = { ...record };
  if (next.expectedLabel === label || next.autoLabel === label) {
    next.autoLabel = label;
    delete next.expectedLabel;
    next.manual = false;
  } else {
    delete next.expectedLabel;
    next.manual = true;
  }
  next.observedLabel = label;
  return next;
}

export function prepareRename(
  record: OwnershipRecord | undefined,
  label: string,
): OwnershipRecord {
  return { ...record, expectedLabel: label, manual: false };
}

export function resetOwnership(
  record: OwnershipRecord | undefined,
): OwnershipRecord {
  const next = { ...record, manual: false };
  delete next.autoLabel;
  delete next.expectedLabel;
  return next;
}

export function titleCase(input: unknown): string {
  const acronyms = new Set(["api", "cli", "ui", "pr", "var", "rpc", "mvp"]);
  return String(input ?? "")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (acronyms.has(word.toLowerCase())) return word.toUpperCase();
      // Preserve acronyms the caller already capitalised (YOLO, AWS, SQL).
      // Re-casing them would corrupt a name on every evaluation pass.
      if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) {
        return word;
      }
      return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function validateTabLabel(label: unknown): label is string {
  if (/[\r\n]/.test(String(label ?? ""))) return false;
  const value = sanitizeText(label);
  if (!value || value.length > MAX_TAB_LENGTH) return false;
  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const connectors = new Set(["a", "an", "and", "for", "in", "of", "on", "to", "with"]);
  return words.every(
    (word, index) =>
      /^[A-Z0-9][A-Za-z0-9+.#/'-]*$/.test(word) ||
      (index > 0 && connectors.has(word)),
  );
}

interface WorkspaceIdentity {
  label?: unknown;
  number?: unknown;
  worktree?: { repo_name?: unknown } | null | undefined;
}

interface StablePane {
  foreground_cwd?: string | undefined;
  cwd?: string | undefined;
}

export function workspaceCandidate(
  workspace: WorkspaceIdentity,
  stablePane?: StablePane,
  gitRoot?: string | null,
): string {
  const current = String(workspace.label ?? "").trim();
  const stableCurrent =
    current && !isDefaultLabel(current, workspace.number) ? current : null;
  const identity =
    workspace.worktree?.repo_name ||
    stableCurrent ||
    (gitRoot && path.basename(gitRoot)) ||
    path.basename(stablePane?.foreground_cwd || stablePane?.cwd || "") ||
    current;
  return titleCase(identity);
}

/**
 * The project a pane is working in, from the checkout rather than the label.
 * `workspaceCandidate` prefers a meaningful existing label, so once a
 * workspace has been auto-named after its agent ("Claude") that label would
 * shadow the real project forever. Naming a tab after its project needs the
 * checkout, so resolve it independently and return null for a generic
 * container like `coding`, which identifies nothing.
 */
export function projectIdentity(
  workspace: WorkspaceIdentity,
  stablePane?: StablePane,
  gitRoot?: string | null,
): string | null {
  const source =
    workspace.worktree?.repo_name ||
    (gitRoot && path.basename(gitRoot)) ||
    path.basename(stablePane?.foreground_cwd || stablePane?.cwd || "");
  const name = titleCase(source ?? "");
  if (!name) return null;
  return isGenericWorkspaceName(name, Boolean(workspace.worktree?.repo_name))
    ? null
    : name;
}

/**
 * Directory names that identify a generic code dump rather than a project.
 * When a workspace resolves to one of these there is no useful identity to
 * show, so callers should fall back to naming it after the work being done.
 */
const GENERIC_WORKSPACE_NAMES = new Set([
  "coding",
  "code",
  "src",
  "source",
  "dev",
  "projects",
  "repos",
  "workspace",
  "home",
  "desktop",
  "documents",
  "temp",
  "tmp",
  "system32",
  "administrator",
  "users",
]);

/**
 * True when a cwd-derived workspace name carries no distinguishing signal.
 *
 * Every workspace rooted at the same generic folder (the common case on this
 * machine, where everything lives under `coding`) collapses to an identical
 * label. Detecting that lets the service name the workspace after its task
 * instead, which is the only way to tell those workspaces apart.
 */
export function isGenericWorkspaceName(
  name: unknown,
  hasWorktree = false,
): boolean {
  if (hasWorktree) return false;
  const value = String(name ?? "").trim().toLowerCase();
  if (!value) return true;
  return GENERIC_WORKSPACE_NAMES.has(value);
}

/**
 * Known agent CLI slugs (Herdr's `pane.agent` value) mapped to their display
 * name. Falls back to title-casing the slug so a CLI added later still gets
 * a readable name instead of being silently dropped.
 */
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  gemini: "Gemini",
  aider: "Aider",
  cursor: "Cursor",
  jcode: "JCode",
  muse: "Muse Code",
};

export function agentDisplayName(agent: unknown): string | null {
  const value = String(agent ?? "").trim().toLowerCase();
  if (!value) return null;
  return AGENT_DISPLAY_NAMES[value] ?? titleCase(value);
}

export function heuristicTitle(context: {
  focusedPane?: {
    process?: Partial<ProcessInfo> | null;
    recentOutput?: string;
  };
}): string | null {
  const process = `${context.focusedPane?.process?.name ?? ""} ${context.focusedPane?.process?.command ?? ""}`.toLowerCase();
  const output = String(context.focusedPane?.recentOutput ?? "").toLowerCase();
  if (/\b(vitest|jest|pytest|rspec|cargo test|go test|node --test|bun test)\b/.test(process)) return "Run Tests";
  if (/\b(next|vite|webpack|astro|rails server|npm run dev|pnpm dev|yarn dev)\b/.test(process)) return "Dev Server";
  if (/\b(tail|journalctl|docker logs)\b/.test(process) || /following logs/.test(output)) return "View Logs";
  if (/\b(ssh|mosh)\b/.test(process)) return "Remote Shell";
  return null;
}

function boundedProcess(
  process: ProcessInfo | null | undefined,
  commandLimit = 400,
): ProcessInfo | null {
  if (!process) return null;
  return {
    name: boundedText(process.name, 80),
    command: boundedText(process.command, commandLimit),
    cwd: boundedText(process.cwd, 160),
  };
}

export function buildModelContext({
  project: projectName,
  paneContexts,
}: {
  project: string | null;
  paneContexts: PaneContext[];
}): NamingContext {
  // Omitted rather than blanked when unknown, so the model is never invited to
  // name a tab after a placeholder.
  const project = projectName ? { project: boundedText(projectName, 80) } : {};
  const focused = paneContexts.find((pane) => pane.focused) ?? paneContexts[0];
  const requests = (focused?.userMessages ?? [])
    .map((text) => boundedText(text, 700))
    .filter(Boolean)
    .slice(-6);
  const timeline = focused?.sessionMessages;
  const hasTimeline = ["origin", "middle", "recent"].some(
    (section) => timeline?.[section as keyof SessionTimeline]?.length,
  );

  let context: NamingContext = requests.length
    ? hasTimeline && timeline
      ? {
          ...project,
          sessionTimeline: {
            origin: timeline.origin.map((text) => boundedText(text, 700)).filter(Boolean),
            middle: timeline.middle.map((text) => boundedText(text, 700)).filter(Boolean),
            recent: timeline.recent.map((text) => boundedText(text, 700)).filter(Boolean),
          },
        }
      : { ...project, userRequests: requests }
    : {
        ...project,
        focusedPane: {
          process: boundedProcess(focused?.process),
          recentOutput: boundedText(focused?.recentOutput, 500),
        },
        siblingPanes: paneContexts
          .filter((pane) => !pane.focused)
          .slice(0, 4)
          .map((pane) => ({
            label: boundedText(pane.label, 80),
            process: boundedProcess(pane.process, 240),
          })),
      };

  if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
    context = requests.length
      ? hasTimeline && timeline
        ? {
            ...project,
            sessionTimeline: {
              origin: timeline.origin.slice(0, 1).map((text) => boundedText(text, 300)),
              middle: timeline.middle.slice(0, 1).map((text) => boundedText(text, 300)),
              recent: timeline.recent.slice(-3).map((text) => boundedText(text, 350)),
            },
          }
        : {
            ...project,
            userRequests: requests.slice(-3).map((text) => boundedText(text, 350)),
          }
      : {
          ...project,
          focusedPane: {
            process: boundedProcess(focused?.process, 250),
            recentOutput: boundedText(focused?.recentOutput, 350),
          },
        };
  }

  if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
    throw new Error("model context exceeded hard limit");
  }
  return context;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function observeStableContext(
  state: SmartRenameState,
  tabId: string,
  context: NamingContext,
): boolean {
  const mark = fingerprint(context);
  if (state.pendingFingerprints[tabId] === mark) return true;
  state.pendingFingerprints[tabId] = mark;
  return false;
}

/**
 * True when the context describes what the user asked for rather than what the
 * terminal happens to be drawing. Transcript context is stable between sweeps;
 * pane output is not, since a spinner or token counter rewrites itself every
 * second.
 */
export function isTranscriptContext(context: NamingContext): boolean {
  return "sessionTimeline" in context || "userRequests" in context;
}

/**
 * Naming again on every message is nearly all waste: the topic is settled after
 * the first few, and calls after that re-derive the label the tab already has.
 * Re-check on a widening interval instead — messages 1, 3, 7, 15, 31 — which
 * costs about five requests over a fifty-message session while still noticing a
 * genuine change of subject within a few messages of it happening.
 */
export function shouldRenameAtChange(changes: number): boolean {
  const next = changes + 1;
  return next > 0 && (next & (next - 1)) === 0;
}

export function shouldCallModel(
  state: SmartRenameState,
  tabId: string,
  context: NamingContext,
  now = Date.now(),
): { allowed: boolean; fingerprint: string } {
  const mark = fingerprint(context);
  // Nothing the namer would see has changed, so any call would re-derive the
  // label it already produced. This is the check that keeps idle tabs free.
  if (state.fingerprints[tabId] === mark) {
    return { allowed: false, fingerprint: mark };
  }

  // Terminal-derived context has no message to count: its fingerprint changes
  // on every redraw, so the clock is the only thing standing between it and a
  // request per sweep.
  if (!isTranscriptContext(context)) {
    return {
      allowed: now - (state.modelAttempts[tabId] ?? 0) >= MODEL_RATE_MS,
      fingerprint: mark,
    };
  }

  // A transcript fingerprint moves once per user message, so counting the moves
  // counts the conversation. The cooldown does not apply here — it exists to
  // damp redraw noise, and waiting it out would only delay a real rename.
  const changes = (state.contextChanges?.[tabId] ?? 0) + 1;
  state.contextChanges = { ...state.contextChanges, [tabId]: changes };
  const named = state.namedAt?.[tabId];
  return {
    allowed: named === undefined || shouldRenameAtChange(changes),
    fingerprint: mark,
  };
}

/**
 * Records that a tab is now carrying a model-derived label, which starts the
 * backoff. Only called when a label was actually produced, so a tab the namer
 * declined keeps trying on the next message instead of going quiet.
 */
export function markNamed(state: SmartRenameState, tabId: string): void {
  state.namedAt = {
    ...state.namedAt,
    [tabId]: state.contextChanges?.[tabId] ?? 0,
  };
}

/**
 * Condenses an agent's own session title into something `validateTabLabel`
 * accepts, so a tab still gets a real name when the namer is unavailable — a
 * rate-limited free tier, most often. Returns null when nothing usable
 * survives rather than forcing a bad label.
 */
export function agentTitleLabel(title: unknown): string | null {
  const connectors = new Set([
    "a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
  ]);
  const words = titleCase(sanitizeText(title))
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  while (words.length && connectors.has(words[words.length - 1]!.toLowerCase())) {
    words.pop();
  }
  const label = words.join(" ");
  return validateTabLabel(label) ? label : null;
}

export function markModelAttempt(
  state: SmartRenameState,
  tabId: string,
  now = Date.now(),
): void {
  state.modelAttempts[tabId] = now;
}

export function markModelSuccess(
  state: SmartRenameState,
  tabId: string,
  context: NamingContext,
): void {
  state.fingerprints[tabId] = fingerprint(context);
  delete state.pendingFingerprints[tabId];
}
