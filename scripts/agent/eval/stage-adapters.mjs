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

import { classify } from "../severity.mjs";

/** Resolve a BlobRef (`{sha256,bytes}`) from a stage-fixtures version to its
 * content string — how prepareInput turns a frozen reference back into the diff /
 * rubric / issue / changed-files the stage consumed. null ref → null. */
export function resolveBlobRef(store, version, ref) {
  return ref && ref.sha256 ? store.getStageBlob(version, ref.sha256) : null;
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

/** Stage → adapter registry. detection/verifier land next (they invoke the model). */
export const STAGE_ADAPTERS = { gate: gateAdapter };
