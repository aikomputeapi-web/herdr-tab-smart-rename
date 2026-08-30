import {
  acknowledgeRename,
  agentDisplayName,
  agentTitleLabel,
  buildModelContext,
  heuristicTitle,
  isDefaultLabel,
  isGenericWorkspaceName,
  markModelAttempt,
  markNamed,
  markModelSuccess,
  observeStableContext,
  prepareRename,
  projectIdentity,
  reconcileItem,
  resetOwnership,
  shouldCallModel,
  workspaceCandidate,
  type PaneContext,
  type RenameChange,
  type RenameResult,
  type SmartRenameState,
} from "./domain.ts";
import {
  focusedPaneContext,
  gitRoot,
  rename,
  reportWorkspaceTask,
  siblingPaneContext,
  snapshot,
  type HerdrPane,
  type HerdrSnapshot,
  type HerdrTab,
  type HerdrWorkspace,
} from "./herdr.ts";
import { AiSdkNamer, type Namer } from "./provider.ts";
import {
  loadState,
  statePaths,
  withStateTransaction,
} from "./storage.ts";

export interface ServiceDependencies {
  snapshot(env?: NodeJS.ProcessEnv): Promise<HerdrSnapshot>;
  gitRoot(cwd?: string): Promise<string | null>;
  focusedPaneContext(
    pane: HerdrPane,
    env?: NodeJS.ProcessEnv,
  ): Promise<PaneContext>;
  siblingPaneContext(
    pane: HerdrPane,
    env?: NodeJS.ProcessEnv,
  ): Promise<PaneContext>;
  rename(
    kind: "workspace" | "tab",
    id: string,
    label: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<void>;
  reportWorkspaceTask(
    workspaceId: string,
    task: string | null,
    env?: NodeJS.ProcessEnv,
  ): Promise<void>;
}

export interface EvaluateOptions {
  snapshot?: HerdrSnapshot;
  resetKind?: "workspace" | "tab" | null;
  forceModel?: boolean;
  forceRefresh?: boolean;
}

export type ModelActivity = (
  tab: HerdrTab,
) => Promise<() => Promise<void>>;

interface ServiceOptions {
  stateFile?: string | null;
  stateLock?: string | null;
  namer: Namer;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  modelActivity?: ModelActivity;
  dependencies?: Partial<ServiceDependencies>;
}

const defaultDependencies: ServiceDependencies = {
  snapshot,
  gitRoot,
  focusedPaneContext,
  siblingPaneContext,
  rename,
  reportWorkspaceTask,
};

export function focusedPaneFor(
  tab: HerdrTab,
  snap: HerdrSnapshot,
): HerdrPane | undefined {
  const panes = snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
  const layout = snap.layouts.find((item) => item.tab_id === tab.tab_id);
  const id = layout?.focused_pane_id ?? snap.focused_pane_id;
  const focused = panes.find((pane) => pane.pane_id === id);
  return (
    (focused?.agent ? focused : undefined) ??
    panes.find(
      (pane) =>
        pane.agent && ["working", "blocked"].includes(pane.agent_status ?? ""),
    ) ??
    focused ??
    panes[0]
  );
}

export function reconcileSnapshot(
  state: SmartRenameState,
  snap: HerdrSnapshot,
): SmartRenameState {
  for (const workspace of snap.workspaces) {
    // A workspace's initial label is often a generic cwd basename (e.g.
    // "coding") rather than blank or numeric. Without also treating generic
    // names as eligible, that label reads as an intentional user rename the
    // very first time we see it, and the workspace gets locked out of
    // auto-naming forever.
    const eligible =
      isDefaultLabel(workspace.label, workspace.number) ||
      isGenericWorkspaceName(workspace.label, Boolean(workspace.worktree?.repo_name));
    state.workspaces[workspace.workspace_id] = reconcileItem(
      state.workspaces[workspace.workspace_id],
      workspace.label,
      eligible,
    );
  }
  for (const tab of snap.tabs) {
    state.tabs[tab.tab_id] = reconcileItem(
      state.tabs[tab.tab_id],
      tab.label,
      isDefaultLabel(tab.label, tab.number),
    );
  }
  return state;
}

export class AutoNameService {
  readonly #stateFile: string | null;
  readonly #stateLock: string | null;
  readonly #namer: Namer;
  readonly #env: NodeJS.ProcessEnv;
  readonly #dryRun: boolean;
  readonly #modelActivity: ModelActivity | undefined;
  readonly #dependencies: ServiceDependencies;

  constructor({
    stateFile = null,
    stateLock = null,
    namer,
    env = process.env,
    dryRun = false,
    modelActivity,
    dependencies = {},
  }: ServiceOptions) {
    this.#stateFile = stateFile;
    this.#stateLock = stateLock;
    this.#namer = namer;
    this.#env = env;
    this.#dryRun = dryRun;
    this.#modelActivity = modelActivity;
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async initialize(initial?: HerdrSnapshot | null): Promise<HerdrSnapshot> {
    const current = initial ?? (await this.#dependencies.snapshot(this.#env));
    if (this.#dryRun || !this.#stateFile || !this.#stateLock) return current;
    await withStateTransaction(this.#stateFile, this.#stateLock, (state) => {
      reconcileSnapshot(state, current);
    });
    return current;
  }

  async acknowledge(
    kind: "workspace" | "tab",
    id: string,
    label: string,
  ): Promise<void> {
    if (!this.#stateFile || !this.#stateLock) return;
    await withStateTransaction(this.#stateFile, this.#stateLock, (state) => {
      const collection = kind === "tab" ? state.tabs : state.workspaces;
      collection[id] = acknowledgeRename(collection[id], label);
    });
  }

  private async contextFor(
    tab: HerdrTab,
    snap: HerdrSnapshot,
    project: string | null,
  ): Promise<{
    focusedPane: HerdrPane | undefined;
    paneContexts: PaneContext[];
    context: ReturnType<typeof buildModelContext>;
  }> {
    const focusedPane = focusedPaneFor(tab, snap);
    const panes = snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
    const paneContexts: PaneContext[] = [];
    for (const pane of panes) {
      paneContexts.push(
        pane.pane_id === focusedPane?.pane_id
          ? await this.#dependencies.focusedPaneContext(pane, this.#env)
          : await this.#dependencies.siblingPaneContext(pane, this.#env),
      );
    }
    return {
      focusedPane,
      paneContexts,
      context: buildModelContext({ project, paneContexts }),
    };
  }

  private async workspaceDetails(
    workspace: HerdrWorkspace,
    snap: HerdrSnapshot,
  ): Promise<{
    stablePane: HerdrPane | undefined;
    workspaceName: string;
    projectName: string | null;
    workspaceIsGeneric: boolean;
  }> {
    const stablePane = snap.panes.find(
      (pane) => pane.workspace_id === workspace.workspace_id,
    );
    // Tab labels now lead with the project, so the checkout is needed on every
    // pass rather than only when the workspace label needs a fallback. A
    // worktree already carries its repo name and needs no lookup.
    const root = workspace.worktree?.repo_name
      ? null
      : await this.#dependencies.gitRoot(
          stablePane?.foreground_cwd ?? stablePane?.cwd,
        );
    const workspaceName = workspaceCandidate(workspace, stablePane, root);
    return {
      stablePane,
      workspaceName,
      projectName: projectIdentity(workspace, stablePane, root),
      workspaceIsGeneric: isGenericWorkspaceName(
        workspaceName,
        Boolean(workspace.worktree?.repo_name),
      ),
    };
  }

  async evaluateAll(
    initial?: HerdrSnapshot | null,
    options: EvaluateOptions = {},
  ): Promise<RenameResult[]> {
    const snap = initial ?? (await this.#dependencies.snapshot(this.#env));
    const results: RenameResult[] = [];
    for (const tab of snap.tabs) {
      const result = await this.evaluate(tab.tab_id, options);
      if (result) results.push(result);
    }
    return results;
  }

  async evaluate(
    tabId: string,
    options: EvaluateOptions = {},
  ): Promise<RenameResult | null> {
    if (this.#dryRun || !this.#stateFile || !this.#stateLock) {
      const snap =
        options.snapshot ?? (await this.#dependencies.snapshot(this.#env));
      const state = await loadState(this.#stateFile);
      reconcileSnapshot(state, snap);
      return this.evaluateWithState(
        state,
        async () => {},
        tabId,
        snap,
        options,
      );
    }
    return withStateTransaction(
      this.#stateFile,
      this.#stateLock,
      async (state, persist) => {
        const snap = await this.#dependencies.snapshot(this.#env);
        reconcileSnapshot(state, snap);
        return this.evaluateWithState(state, persist, tabId, snap, options);
      },
    );
  }

  private async evaluateWithState(
    state: SmartRenameState,
    persist: () => Promise<void>,
    tabId: string,
    snap: HerdrSnapshot,
    options: EvaluateOptions,
  ): Promise<RenameResult | null> {
    let tab = snap.tabs.find((item) => item.tab_id === tabId);
    if (!tab) return null;
    let workspace = snap.workspaces.find(
      (item) => item.workspace_id === tab!.workspace_id,
    );
    if (!workspace) return null;

    if (options.resetKind === "tab") {
      state.tabs[tab.tab_id] = resetOwnership(state.tabs[tab.tab_id]);
    }
    if (options.resetKind === "workspace") {
      state.workspaces[workspace.workspace_id] = resetOwnership(
        state.workspaces[workspace.workspace_id],
      );
    }

    let workspaceRecord = state.workspaces[workspace.workspace_id];
    let tabRecord = state.tabs[tab.tab_id];
    let workspaceManual = workspaceRecord?.manual ?? false;
    let tabManual = tabRecord?.manual ?? false;

    if (workspaceManual && tabManual) {
      return {
        dryRun: this.#dryRun,
        workspace: workspace.workspace_id,
        tab: tab.tab_id,
        candidate: { workspace: null, tab: null },
        reason: "manual ownership",
        usedModel: false,
        ownership: { workspaceManual, tabManual },
        changes: [],
      };
    }

    const { workspaceName, projectName, workspaceIsGeneric } =
      await this.workspaceDetails(workspace, snap);
    let tabName: string | null = null;
    let reason = tabManual ? "manual tab ownership" : "";
    let usedModel = false;

    if (!tabManual) {
      const details = await this.contextFor(tab, snap, projectName);
      const focusedContext = details.paneContexts.find((pane) => pane.focused);
      const hasUserTask = Boolean(focusedContext?.userMessages.length);
      const heuristic = hasUserTask
        ? null
        : heuristicTitle(focusedContext ? { focusedPane: focusedContext } : {});
      if (heuristic && !options.forceModel) {
        tabName = heuristic;
        reason = "process heuristic";
      } else {
        const weakCommandContext = !hasUserTask && !details.focusedPane?.agent;
        const contextReady =
          !weakCommandContext ||
          options.forceModel ||
          options.forceRefresh ||
          observeStableContext(state, tab.tab_id, details.context);
        if (!contextReady) {
          reason = "waiting for stable command context";
        } else {
          const gate = shouldCallModel(state, tab.tab_id, details.context);
          // The agent's own session title costs nothing and is only consulted
          // when the namer produces no label, so it never overrides a real
          // suggestion.
          const fallbackTitle = agentTitleLabel(focusedContext?.sessionTitle);
          if (gate.allowed || options.forceModel || options.forceRefresh) {
            markModelAttempt(state, tab.tab_id);
            if (!this.#dryRun) await persist();
            const stopActivity = await this.#modelActivity?.(tab);
            try {
              const suggestion = await this.#namer.suggest(details.context);
              markModelSuccess(state, tab.tab_id, details.context);
              tabName = suggestion.tab ?? fallbackTitle;
              reason =
                suggestion.tab || !fallbackTitle
                  ? suggestion.reason
                  : `${suggestion.reason}; used agent session title`;
              usedModel = true;
            } catch (error) {
              if (!fallbackTitle) throw error;
              // An exhausted free tier or a provider outage should not leave the
              // tab on "1" when the agent has already titled the session itself.
              // Record the fingerprint anyway so a persistent outage costs one
              // request per context change rather than one per sweep; the next
              // message the user sends moves it and earns a fresh attempt.
              markModelSuccess(state, tab.tab_id, details.context);
              tabName = fallbackTitle;
              reason = `agent session title (${errorMessage(error)})`;
              usedModel = true;
            } finally {
              await stopActivity?.();
            }
            // Starts the backoff only once the tab actually carries a label, so
            // a tab the namer declined keeps trying on the next message.
            if (tabName) markNamed(state, tab.tab_id);
          } else {
            reason = "unchanged or rate-limited context";
          }
        }
      }
    }

    if (!this.#dryRun) {
      const latest = await this.#dependencies.snapshot(this.#env);
      reconcileSnapshot(state, latest);
      tab = latest.tabs.find((item) => item.tab_id === tabId);
      if (!tab) return null;
      workspace = latest.workspaces.find(
        (item) => item.workspace_id === tab!.workspace_id,
      );
      if (!workspace) return null;
      workspaceRecord = state.workspaces[workspace.workspace_id];
      tabRecord = state.tabs[tab.tab_id];
      workspaceManual = workspaceRecord?.manual ?? false;
      tabManual = tabRecord?.manual ?? false;
    }

    const changes: RenameChange[] = [];

    // A workspace whose name comes from a generic folder (e.g. everything under
    // `coding`) is indistinguishable from its siblings. In that case prefer the
    // name of the agent CLI running in it (Claude, Codex, OpenCode, ...) since
    // that is a stable per-workspace identity; fall back to the task-derived
    // tab name for plain shells with no agent. Real projects and git
    // worktrees keep their identity.
    //
    // Only the workspace's active tab may set the name. Without this, every tab
    // in a multi-tab workspace overwrites the label in turn and the sidebar
    // flickers between unrelated task names.
    const activeTabId = workspace.active_tab_id ?? tab.tab_id;
    const tabOwnsWorkspaceName = activeTabId === tab.tab_id;
    const workspaceAgentName = agentDisplayName(focusedPaneFor(tab, snap)?.agent);

    // A workspace we already auto-named stays under our control even though its
    // new label no longer looks generic. Without this the label gets re-derived
    // and pushed back through titleCase, corrupting acronyms on every pass
    // ("Enable YOLO Mode" -> "Enable Yolo Mode").
    const previousAuto = workspaceRecord?.autoLabel;
    const workspaceAutoNamed = Boolean(
      previousAuto && workspace.label === previousAuto,
    );

    let effectiveWorkspaceName = workspaceName;
    if (workspaceIsGeneric || workspaceAutoNamed) {
      effectiveWorkspaceName =
        (tabOwnsWorkspaceName ? workspaceAgentName ?? tabName : null) ??
        previousAuto ??
        workspaceName;
    }

    if (
      !workspaceManual &&
      effectiveWorkspaceName &&
      workspace.label !== effectiveWorkspaceName
    ) {
      changes.push({
        kind: "workspace",
        id: workspace.workspace_id,
        from: workspace.label,
        to: effectiveWorkspaceName,
      });
    }
    if (!tabManual && tabName && tab.label !== tabName) {
      changes.push({
        kind: "tab",
        id: tab.tab_id,
        from: tab.label,
        to: tabName,
      });
    }

    if (!this.#dryRun) {
      for (const change of changes) {
        const collection =
          change.kind === "tab" ? state.tabs : state.workspaces;
        const previous = collection[change.id];
        collection[change.id] = prepareRename(previous, change.to);
        await persist();
        try {
          await this.#dependencies.rename(
            change.kind,
            change.id,
            change.to,
            this.#env,
          );
        } catch (error) {
          if (previous) collection[change.id] = previous;
          else delete collection[change.id];
          await persist();
          throw error;
        }
      }
    }

    // Herdr's Spaces rows have no tab element, so the task line has to arrive
    // as workspace metadata. Publishing only on a mismatch keeps this free on
    // idle sweeps and still repairs itself after a restart clears the tokens.
    if (!this.#dryRun && tabOwnsWorkspaceName) {
      const task = tabName ?? tab.label;
      if (workspace.tokens?.["task"] !== task) {
        await this.#dependencies
          .reportWorkspaceTask(workspace.workspace_id, task, this.#env)
          // A sidebar decoration must never block a rename.
          .catch(() => {});
      }
    }

    return {
      dryRun: this.#dryRun,
      workspace: workspace.workspace_id,
      tab: tab.tab_id,
      candidate: { workspace: effectiveWorkspaceName, tab: tabName },
      reason,
      usedModel,
      ownership: { workspaceManual, tabManual },
      changes,
    };
  }
}

interface CompositionOptions {
  stateDir?: string | null;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  namer?: Namer;
  modelActivity?: ModelActivity;
  dependencies?: Partial<ServiceDependencies>;
}

export function createService({
  stateDir = null,
  env = process.env,
  dryRun = false,
  namer = new AiSdkNamer(env),
  modelActivity,
  dependencies = {},
}: CompositionOptions = {}): AutoNameService {
  const paths = stateDir ? statePaths(stateDir) : null;
  return new AutoNameService({
    stateFile: paths?.state ?? null,
    stateLock: paths?.stateLock ?? null,
    namer,
    env,
    dryRun,
    ...(modelActivity ? { modelActivity } : {}),
    dependencies,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
