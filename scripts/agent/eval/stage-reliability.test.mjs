import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionForStage, computeStageReliability } from "./stage-reliability.mjs";

const env = (stage, output, over = {}) => ({ stage_id: stage, status: "ok", output, fixture_ref: "x", ...over });

// --- decisionForStage --------------------------------------------------------

test("decisionForStage: gate → block/approve; non-ok / no-output → null", () => {
  assert.equal(decisionForStage("gate", env("gate", { verdict: "block" })), "block");
  assert.equal(decisionForStage("gate", env("gate", { verdict: "approve" })), "approve");
  assert.equal(decisionForStage("gate", env("gate", { verdict: "block" }, { status: "error" })), null);
  assert.equal(decisionForStage("gate", { status: "ok" }), null);
});

test("decisionForStage: verifier → drop/keep; errored verdict → null (excluded)", () => {
  assert.equal(decisionForStage("verifier", env("verifier", { decision: { verdict: "refuted" }, error: null, dropped: true })), "drop");
  assert.equal(decisionForStage("verifier", env("verifier", { decision: { verdict: "confirmed" }, error: null, dropped: false })), "keep");
  assert.equal(decisionForStage("verifier", env("verifier", { decision: null, error: { message: "x" }, dropped: false })), null);
});

test("decisionForStage: detection → sorted-agnostic finding-key set", () => {
  const d = decisionForStage("detection", env("detection", { union: [{ file: "a.ts", summary: "Boom" }, { file: "b.ts", summary: "x" }] }));
  assert.deepEqual(d, ["a.ts::boom", "b.ts::x"]);
  assert.deepEqual(decisionForStage("detection", env("detection", { union: [] })), []);
});

// --- binary stages (gate / verifier) ----------------------------------------

test("computeStageReliability: gate — flip-rate + κ over block/approve", () => {
  const runs = [
    { runId: "r1", decisions: { f1: "block", f2: "block", f3: "approve" } },
    { runId: "r2", decisions: { f1: "block", f2: "approve", f3: "approve" } }, // f2 flips
  ];
  const r = computeStageReliability("gate", runs);
  assert.equal(r.aggregate.n, 3);
  assert.equal(r.aggregate.k_runs, 2);
  assert.ok(Math.abs(r.aggregate.flip_rate - 1 / 3) < 1e-9); // only f2 unstable
  assert.equal(r.per_fixture.f2.stable, false);
  assert.equal(r.per_fixture.f1.stable, true);
  assert.equal(typeof r.aggregate.kappa === "number" || r.aggregate.kappa === null, true);
});

test("computeStageReliability: verifier — drop/keep binary", () => {
  const runs = [
    { runId: "r1", decisions: { f1: "drop", f2: "keep" } },
    { runId: "r2", decisions: { f1: "keep", f2: "keep" } }, // f1 flips
  ];
  const r = computeStageReliability("verifier", runs);
  assert.equal(r.aggregate.flip_rate, 0.5);
  assert.equal(r.per_fixture.f1.stable, false);
  assert.equal(r.per_fixture.f2.drop, 0);
  assert.equal(r.per_fixture.f2.keep, 2);
});

test("computeStageReliability: excludes fixtures not decided in ALL runs", () => {
  const runs = [
    { runId: "r1", decisions: { f1: "block", f2: "block" } },
    { runId: "r2", decisions: { f1: "block", f2: null } }, // f2 errored in r2 → excluded
  ];
  const r = computeStageReliability("gate", runs);
  assert.equal(r.aggregate.n, 1);            // only f1 scored
  assert.equal(r.aggregate.items_excluded, 1);
});

// --- detection (open-ended → overlap, not κ) --------------------------------

test("computeStageReliability: detection — mean pairwise Jaccard of finding-key sets", () => {
  const runs = [
    { runId: "r1", decisions: { same: ["a::x", "b::y"], partial: ["a::x", "b::y"], empty: [] } },
    { runId: "r2", decisions: { same: ["a::x", "b::y"], partial: ["a::x"], empty: [] } },
  ];
  const r = computeStageReliability("detection", runs);
  assert.equal(r.per_fixture.same.mean_jaccard, 1);   // identical sets
  assert.equal(r.per_fixture.same.stable, true);
  assert.equal(r.per_fixture.partial.mean_jaccard, 0.5); // {a,b} vs {a} → 1/2
  assert.equal(r.per_fixture.empty.mean_jaccard, 1);  // both found nothing = consistent
  assert.ok(Math.abs(r.aggregate.mean_jaccard - (1 + 0.5 + 1) / 3) < 1e-9);
  assert.match(r.method, /Jaccard/);
});

test("computeStageReliability: <2 runs → note, no crash", () => {
  const r = computeStageReliability("gate", [{ runId: "r1", decisions: { f1: "block" } }]);
  assert.equal(r.aggregate.k_runs, 1);
  assert.match(r.aggregate.note, /need/);
});

test("computeStageReliability: nothing scorable → null, NOT a passing 0/1.0", () => {
  // Every fixture errored in one run (the #521 pilot shape: detection-2 all 429'd).
  const binRuns = [
    { runId: "r1", decisions: { f1: "block", f2: "block" } },
    { runId: "r2", decisions: { f1: null, f2: null } },
  ];
  const g = computeStageReliability("gate", binRuns);
  assert.equal(g.aggregate.n, 0);
  assert.equal(g.aggregate.flip_rate, null);   // not 0 — 0 would read as "stable"
  assert.match(g.aggregate.note, /no data/);

  const detRuns = [
    { runId: "r1", decisions: { f1: ["a::x"] } },
    { runId: "r2", decisions: { f1: null } },
  ];
  const d = computeStageReliability("detection", detRuns);
  assert.equal(d.aggregate.n, 0);
  assert.equal(d.aggregate.mean_jaccard, null); // not 1.0 — 1.0 would read as "perfect"
  assert.match(d.aggregate.note, /no data/);
});
