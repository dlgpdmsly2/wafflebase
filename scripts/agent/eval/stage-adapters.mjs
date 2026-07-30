// Stage adapters — the Target Adapter seam generalized to STAGE level (Mode A
// task 4). Where `adapters/reviewer.mjs` makes the whole panel one target keyed on
// a corpus item, a stage adapter makes ONE review stage a target keyed on a frozen
// stage FIXTURE (see eval/stage-artifacts.md): replay just that stage against the
// fixture's frozen input, K times, to measure THAT stage's decision stability.
//
// Contract (mirrors the reviewer adapter's prepareInput/runAgent/capture shape):
//
//   stage_id                       which stage this adapter replays
//   prepareInput(fixture, opts)    materialize the fixture's frozen INPUT into a
//                                  runnable form (resolve BlobRefs → content,
//                                  repo_commit → a checked-out tree). opts:
//                                  { store, version, repoSource, repoCache }.
//   runReplica(prepared, opts)     replay the stage ONCE → { output, sessionLog }.
//                                  `output` has the SAME shape as fixture.output
//                                  (so replays are comparable to the captured
//                                  baseline); `sessionLog` is the raw SDK result
//                                  messages for cost accounting (empty for a pure
//                                  stage). opts: { env }.
//
// `stage-run.mjs` drives this: loop a stage's fixtures, prepareInput → runReplica,
// write a stage-run envelope carrying stage_id + fixture_ref.
//
// This file implements the GATE adapter — pure, so it is free and its replay is
// deterministic (the "gate determinism check"): a replay must reproduce the
// captured gate output exactly. The DETECTION and VERIFIER adapters (which invoke
// the model, so they cost money to run) plug into this same seam and land next;
// they will reuse review-panel.mjs's own `runLens` / `verifyFinding` on the
// materialized frozen input so the replayed stage is byte-for-byte the shipped one.

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify } from "../severity.mjs";
import {
  runLens, verifyFinding, withRetry, unionSamples, compareSampleAgreement,
  severityCounts, confidenceCounts, changedFileContext, isDroppingVerdict,
} from "../review-panel.mjs";
import { materializeRepoAt } from "./run.mjs";

/** Resolve a BlobRef (`{sha256,bytes}`) from a stage-fixtures version to its
 * content string — how prepareInput turns a frozen reference back into the diff /
 * rubric / issue / changed-files the stage consumed. null ref → null. */
export function resolveBlobRef(store, version, ref) {
  return ref && ref.sha256 ? store.getStageBlob(version, ref.sha256) : null;
}

/** The working tree the stage runs against: the repo checked out at `repo_commit`
 * (`materializeRepoAt`, cached), or a fresh EMPTY dir when unavailable — diff-only.
 * Detection tolerates an empty dir (it has the diff); the independent VERIFIER
 * Greps this tree, so diff-only starves it (a documented low-fidelity mode). */
function resolveRepoDir({ repoSource, repoCache, repo_commit }) {
  const ctx = repoCache ? materializeRepoAt({ repoSource, commit: repo_commit, cacheRoot: repoCache }) : null;
  if (ctx?.path) return ctx.path;
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "stage-repo-")), "repo");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Gate stage adapter — PURE. The gate is a deterministic function of the per-lens
 * kept sets (mirrors severity.classify + the panel/mark-ready rollup): a lens
 * blocks iff it is applicable, blocking, and keeps a critical/major finding; the
 * item blocks iff any such lens does. No model call, so `sessionLog` is empty and
 * a replay always reproduces the captured output — which is exactly the property
 * the gate determinism check asserts.
 */
export const gateAdapter = {
  stage_id: "gate",

  prepareInput(fixture) {
    return { lenses: Array.isArray(fixture?.input?.lenses) ? fixture.input.lenses : [] };
  },

  async runReplica(prepared) {
    const lensConclusion = (l) =>
      !l.applicable ? "skipped" : !l.blocking ? "success" : classify(l.kept ?? []).conclusion;
    const per_lens = prepared.lenses.map((l) => ({ lens_id: l.lens_id, conclusion: lensConclusion(l) }));
    const verdict = prepared.lenses.some(
      (l) => l.applicable && l.blocking && classify(l.kept ?? []).conclusion === "failure",
    ) ? "block" : "approve";
    return { output: { per_lens, verdict }, sessionLog: [] };
  },
};

/**
 * Detection stage adapter — replays a lens's N-sample pass on the frozen diff.
 * Reuses review-panel.mjs's own `runLens` (so the sampled call is byte-for-byte the
 * shipped one) + `unionSamples` / `compareSampleAgreement`, and reports the SAME
 * `detection.output` shape the capture produced. Cost = N model calls per fixture.
 * The frozen `input.diff` is the lens's ROUTED slice (its scopeClasses subset, #582),
 * not the whole PR — set by the capture from stage-detail.lensDiff — so the replay
 * re-reviews exactly what the lens saw in production and pays only for that slice.
 * (No `scopeNote` is threaded: the eval runs the panel in full mode, where it is "".)
 * If EVERY sample fails (e.g. a mid-replay quota outage) it throws, so the runner
 * records an error envelope rather than a false "found nothing" (the same
 * fail-closed rule the panel makes, and the reason infra failures must not read as
 * clean reviews).
 */
export const detectionAdapter = {
  stage_id: "detection",

  prepareInput(fixture, { store, version, repoSource = null, repoCache = null }) {
    const i = fixture.input;
    return {
      lens: { id: fixture.instance.lens_id, title: i.title, model: i.model, needsIssueSpec: i.needs_issue_spec },
      rubric: resolveBlobRef(store, version, i.rubric) ?? "",
      diff: resolveBlobRef(store, version, i.diff) ?? "",
      issue: resolveBlobRef(store, version, i.issue),
      repo: resolveRepoDir({ repoSource, repoCache, repo_commit: i.repo_commit }),
      samples: Math.max(1, Number(i.samples) || 2),
    };
  },

  async runReplica(prepared) {
    const { lens, rubric, diff, issue, repo, samples } = prepared;
    const sessionLog = [];
    const results = await Promise.all(Array.from({ length: samples }, async () => {
      try { return await withRetry(() => runLens(lens, { rubric, diff, issue, repo, sessionLog })); }
      catch (e) { return { __error: e.message }; }
    }));
    const ok = results.filter((r) => r && !r.__error);
    if (ok.length === 0) throw new Error((results[0] && results[0].__error) || "all detection samples failed");
    const perSample = ok.map((r) => (Array.isArray(r.findings) ? r.findings : []));
    const union = unionSamples(ok);
    const output = {
      union, per_sample: perSample, samples_run: samples, samples_ok: ok.length,
      agreement: compareSampleAgreement(perSample),
      severity_counts: severityCounts(union), confidence_counts: confidenceCounts(union),
    };
    return { output, sessionLog };
  },
};

/**
 * Verifier stage adapter — replays the independent refute pass on ONE frozen
 * finding. Reuses `verifyFinding` (NOT given the diff — it re-grounds from the repo
 * checked out at `repo_commit`) + `isDroppingVerdict`, so both the call and the
 * drop rule are the shipped ones. The changed-file trust context is recomputed from
 * the frozen `changed_files` blob via `changedFileContext`, reproducing the same
 * `allowPreExisting` the capture used. An errored verdict KEEPS the finding
 * (dropped=false) — the panel's fail-toward-blocking rule. Cost = 1 model call.
 * (Fidelity note: diff-only replay — no `repo_commit` — starves this stage's Grep.)
 */
export const verifierAdapter = {
  stage_id: "verifier",

  prepareInput(fixture, { store, version, repoSource = null, repoCache = null }) {
    const i = fixture.input;
    const cfText = resolveBlobRef(store, version, i.changed_files);
    const changedFiles = cfText ? cfText.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    return {
      finding: i.finding,
      rubric: resolveBlobRef(store, version, i.rubric) ?? "",
      repo: resolveRepoDir({ repoSource, repoCache, repo_commit: i.repo_commit }),
      model: i.model,
      changedContext: changedFileContext(changedFiles),
    };
  },

  async runReplica(prepared) {
    const { finding, rubric, repo, model, changedContext } = prepared;
    const sessionLog = [];
    let verdict = null;
    try { verdict = await withRetry(() => verifyFinding(finding, { rubric, repo, model, sessionLog, changedContext })); }
    catch { verdict = null; } // error → keep the finding (fail toward blocking, as the panel does)
    const dropped = isDroppingVerdict(verdict, { allowPreExisting: changedContext.authoritative });
    const decided = verdict && typeof verdict === "object" && typeof verdict.verdict === "string";
    const output = decided
      ? {
          decision: {
            verdict: verdict.verdict, confidence: verdict.confidence, reason: verdict.reason ?? "",
            refutationGround: verdict.refutationGround,
            groundedIn: Array.isArray(verdict.groundedIn) ? verdict.groundedIn : [],
          },
          error: null, dropped,
        }
      : { decision: null, error: { message: "verifier produced no verdict (errored or no structured output)", kind: "no-verdict" }, dropped };
    return { output, sessionLog };
  },
};

/** Stage → adapter registry. */
export const STAGE_ADAPTERS = { detection: detectionAdapter, verifier: verifierAdapter, gate: gateAdapter };
