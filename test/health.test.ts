// Unit tests for the AI failure-streak health tracking added 2026-09-30.
//
// The Sept 2026 incident: the worker process stayed alive for weeks while
// every AI call failed with an expired token. `status` said "running" the
// whole time because process liveness was the only signal. These tests pin
// the contract of the failure-streak bookkeeping and its verdict.
import { describe, expect, test } from "bun:test";
import {
  MODEL_DEGRADED_THRESHOLD,
  emptyState,
  markModelFailure,
  markModelSuccess,
  modelHealthSummary,
  modelHealthVerdict,
  type SmartRenameState,
} from "../src/domain.ts";

function stateWithFailures(
  spec: Record<string, { streak: number; attemptedAgoMs?: number }>,
  now: number,
): SmartRenameState {
  const state = emptyState();
  for (const [tabId, { streak, attemptedAgoMs = 0 }] of Object.entries(spec)) {
    for (let i = 0; i < streak; i += 1) markModelFailure(state, tabId);
    if (streak > 0) {
      state.modelAttempts[tabId] = now - attemptedAgoMs;
    }
  }
  return state;
}

function namingContext() {
  return { project: "Health", sessionTimeline: { origin: [], middle: [], recent: [] } };
}

describe("model failure streaks", () => {
  test("markModelFailure accumulates per tab and success clears the streak", () => {
    const state = emptyState();
    markModelFailure(state, "t1");
    markModelFailure(state, "t1");
    markModelFailure(state, "t2");
    expect(state.modelFailures?.t1).toBe(2);
    expect(state.modelFailures?.t2).toBe(1);
    markModelSuccess(state, "t1", namingContext());
    expect(state.modelFailures?.t1).toBeUndefined();
    expect(state.modelFailures?.t2).toBe(1);
  });

  test("an empty state is quiet, not degraded or healthy", () => {
    const health = modelHealthSummary(emptyState());
    expect(health.worstStreak).toBe(0);
    expect(health.degradedTabs).toBe(0);
    expect(modelHealthVerdict(health)).toBe("quiet");
  });

  test("failures below the threshold report healthy with a streak", () => {
    const now = Date.now();
    const health = modelHealthSummary(
      stateWithFailures({ t1: { streak: MODEL_DEGRADED_THRESHOLD - 1 } }, now),
      now,
    );
    expect(health.worstStreak).toBe(MODEL_DEGRADED_THRESHOLD - 1);
    expect(health.degradedTabs).toBe(0);
    expect(modelHealthVerdict(health)).toBe("healthy");
  });

  test("a streak at the threshold is degraded — the silent-failure shape", () => {
    const now = Date.now();
    const health = modelHealthSummary(
      stateWithFailures(
        { t1: { streak: MODEL_DEGRADED_THRESHOLD } },
        now,
      ),
      now,
    );
    expect(health.degradedTabs).toBe(1);
    expect(modelHealthVerdict(health)).toBe("degraded");
  });

  test("streaks from multiple tabs aggregate to the worst one", () => {
    const now = Date.now();
    const health = modelHealthSummary(
      stateWithFailures(
        {
          t1: { streak: 2 },
          t2: { streak: MODEL_DEGRADED_THRESHOLD + 3 },
          t3: { streak: 1 },
        },
        now,
      ),
      now,
    );
    expect(health.worstStreak).toBe(MODEL_DEGRADED_THRESHOLD + 3);
    expect(health.degradedTabs).toBe(1);
    expect(modelHealthVerdict(health)).toBe("degraded");
  });

  test("a success anywhere proves the provider works, verdict stays healthy", () => {
    const now = Date.now();
    const state = stateWithFailures({ t2: { streak: 3 } }, now);
    markModelSuccess(state, "t1", namingContext());
    const health = modelHealthSummary(state, now);
    expect(health.tabsWithSuccess).toBe(1);
    expect(modelHealthVerdict(health)).toBe("healthy");
  });

  test("stale streaks older than the TTL are pruned and ignored", () => {
    const now = Date.now();
    const staleMs = 24 * 60 * 60 * 1000 + 60_000;
    const state = stateWithFailures(
      { t1: { streak: 50, attemptedAgoMs: staleMs } },
      now,
    );
    const health = modelHealthSummary(state, now);
    expect(health.worstStreak).toBe(0);
    expect(modelHealthVerdict(health)).toBe("quiet");
    // Pruned from state entirely so the map cannot grow without bound.
    expect(state.modelFailures?.t1).toBeUndefined();
  });
});
