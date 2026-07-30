import { test } from "node:test";
import assert from "node:assert/strict";
import {
  missRatio, hitProbability, clusterDraws, curveForDraws, flattenPoint,
  analyzeGroup, computeSampleCount, envelopesToGroups,
} from "./sample-count-analysis.mjs";

// Three wordings of ONE defect, at the level of restatement the panel actually
// produces, plus an unrelated defect in the same file. The A/C pair is deliberately
// the weakest link — it is what exercises transitive grouping.
const A = "The retry loop in fetchUser never resets the backoff counter, so a transient failure escalates into a permanent stall";
const B = "backoff counter is not reset by the retry loop, letting a transient failure become a permanent stall";
const C = "retry loop leaves the backoff counter unreset after a transient failure";
const OTHER = "The exported symbol list omits the new helper, breaking the public barrel file";

const f = (summary, severity = "major", file = "src/fetch.ts") => ({ summary, severity, file });
const near = (x, y, eps = 1e-9) => assert.ok(Math.abs(x - y) < eps, `${x} !≈ ${y}`);

// --- combinatorics ----------------------------------------------------------

test("missRatio: hand-computed hypergeometric values", () => {
  near(missRatio(2, 1, 1), 0.5);           // 1 of 2 draws has it, pick 1
  near(missRatio(4, 1, 2), 0.5);           // C(3,2)/C(4,2) = 3/6
  near(missRatio(4, 1, 3), 0.25);          // C(3,3)/C(4,3) = 1/4
  near(missRatio(4, 2, 2), 1 / 6);         // C(2,2)/C(4,2) = 1/6
});

test("missRatio: edges — absent defect, certain hit, empty subset", () => {
  assert.equal(missRatio(4, 0, 2), 1);     // in no draw → never hit
  assert.equal(missRatio(4, 4, 1), 0);     // in every draw → always hit
  assert.equal(missRatio(4, 3, 2), 0);     // N > D-m → too few clean draws remain
  assert.equal(missRatio(4, 1, 0), 1);     // empty subset hits nothing
});

test("hitProbability is the complement", () => {
  near(hitProbability(4, 1, 2), 0.5);
  assert.equal(hitProbability(4, 4, 1), 1);
});

// --- clustering -------------------------------------------------------------

test("clusterDraws: rewordings of one defect collapse; a distinct defect does not", () => {
  const out = clusterDraws([[f(A), f(OTHER)], [f(B)]], { lens: "correctness" });
  assert.equal(out.length, 2);
  const defect = out.find((c) => c.n_draws === 2);
  assert.deepEqual(defect.draws, [0, 1]);
  assert.equal(defect.n_findings, 2);
  const other = out.find((c) => c.n_draws === 1);
  assert.match(other.summary, /barrel file/);
});

test("clusterDraws: transitive — A~C only through B, still one defect", () => {
  const out = clusterDraws([[f(A)], [f(B)], [f(C)]], { lens: "correctness" });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].draws, [0, 1, 2]);
  assert.equal(out[0].wordings.length, 3);
});

test("clusterDraws: a different file never merges, however alike the wording", () => {
  const out = clusterDraws([[f(A, "major", "src/a.ts")], [f(A, "major", "src/b.ts")]], { lens: "correctness" });
  assert.equal(out.length, 2);
});

test("clusterDraws: severity is the max across members; blocking_draws tracks who said so", () => {
  const out = clusterDraws([[f(A, "minor")], [f(B, "critical")]], { lens: "correctness" });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "critical");
  assert.equal(out[0].blocking, true);
  assert.deepEqual(out[0].draws, [0, 1]);
  // Only draw 1 actually reported it at blocking severity.
  assert.deepEqual(out[0].blocking_draws, [1]);
});

test("clusterDraws: the lens stamp is applied — unstamped findings would all score 0", () => {
  // findingSimilarity gates on lens equality; without the stamp these two stay apart.
  const out = clusterDraws([[{ summary: A, severity: "major", file: "src/fetch.ts" }],
                            [{ summary: B, severity: "major", file: "src/fetch.ts" }]], { lens: "correctness" });
  assert.equal(out.length, 1);
  assert.equal(out[0].lens, "correctness");
});

test("clusterDraws: empty and malformed draws are tolerated", () => {
  assert.deepEqual(clusterDraws([[], []], { lens: "correctness" }), []);
  assert.deepEqual(clusterDraws(null, { lens: "correctness" }), []);
  assert.equal(clusterDraws([[{}], [{}]], { lens: "correctness" }).length >= 1, true);
});

// --- the curve --------------------------------------------------------------

test("curveForDraws: exact recall against hand-computed values", () => {
  // D=4. X major in all 4 draws; Y major in draw 0 only; Z minor in draws 0,1.
  const X = (s) => f(A, s, "src/x.ts");
  const Y = f(OTHER, "major", "src/y.ts");
  const Z = f("cache key omits the tenant id so entries leak across tenants", "minor", "src/z.ts");
  const clusters = clusterDraws([[X(), Y, Z], [X(), Z], [X()], [X()]], { lens: "correctness" });
  const curve = curveForDraws(clusters, 4);

  // recall(1) = [hit(4,4,1) + hit(4,1,1)] / 2 = [1 + 0.25] / 2
  near(curve[0].blocking_recall, 0.625);
  // recall(2) = [1 + 0.5] / 2
  near(curve[1].blocking_recall, 0.75);
  near(curve[3].blocking_recall, 1);
  // X blocks in every draw, so the lens always blocks — no instability.
  near(curve[0].block_rate, 1);
  near(curve[0].proxy_flip_rate, 0);
});

test("curveForDraws: a lone blocking draw is where instability lives", () => {
  // D=4, one blocking defect seen by draw 0 only.
  const clusters = clusterDraws([[f(A)], [], [], []], { lens: "correctness" });
  const curve = curveForDraws(clusters, 4);
  near(curve[0].block_rate, 0.25);
  assert.equal(curve[0].proxy_verdict, "approve");   // usually misses it
  near(curve[0].proxy_flip_rate, 0.25);
  near(curve[1].block_rate, 0.5);
  assert.equal(curve[1].proxy_verdict, "block");     // tie resolves to block
  near(curve[1].proxy_flip_rate, 0.5);               // maximally unstable
  near(curve[3].block_rate, 1);
  near(curve[3].proxy_flip_rate, 0);
});

test("curveForDraws: no blocking defect → recall is null, not 0", () => {
  const curve = curveForDraws(clusterDraws([[f(A, "nit")], [f(B, "minor")]], { lens: "docs" }), 2);
  assert.equal(curve[0].blocking_recall, null);
  near(curve[0].block_rate, 0);
});

test("flattenPoint: first N whose next step gains less than epsilon", () => {
  const curve = [
    { n: 1, blocking_recall: 0.5 }, { n: 2, blocking_recall: 0.9 },
    { n: 3, blocking_recall: 0.905 }, { n: 4, blocking_recall: 1 },
  ];
  assert.equal(flattenPoint(curve), 2);
  assert.equal(flattenPoint(curve, { epsilon: 0.5 }), 1);
  assert.equal(flattenPoint([{ n: 1, blocking_recall: null }, { n: 2, blocking_recall: null }]), null);
});

// --- group + aggregate ------------------------------------------------------

test("analyzeGroup: singleton blocking defects are named, and marginal value is reported", () => {
  const g = analyzeGroup({
    item_id: "pr-493", lens_id: "correctness",
    draws: [[f(A), f(OTHER)], [f(B)], [f(C)], []],
  });
  assert.equal(g.n_draws, 4);
  assert.equal(g.n_blocking_defects, 2);          // the A/B/C defect + OTHER
  assert.equal(g.singleton_blocking.length, 1);   // OTHER, seen by draw 0 alone
  assert.match(g.singleton_blocking[0].summary, /barrel file/);
  assert.ok(g.marginal_second_sample > 0);
  assert.equal(g.contested, true);                // 3 of 4 draws block
});

test("analyzeGroup: all draws block, or none do → not contested", () => {
  const all = analyzeGroup({ item_id: "i", lens_id: "l", draws: [[f(A)], [f(B)]] });
  assert.equal(all.contested, false);
  const none = analyzeGroup({ item_id: "i", lens_id: "l", draws: [[], []] });
  assert.equal(none.contested, false);
  assert.equal(none.n_blocking_defects, 0);
});

test("computeSampleCount: recall is micro-averaged over pooled defects", () => {
  // Group P: 1 blocking defect in both draws → recall 1 at every N.
  // Group Q: 2 blocking defects, each in 1 of 2 draws → recall(1) = 0.5.
  // Micro over 3 defects: (1*1 + 0.5*2)/3 = 2/3. A macro mean would give 0.75.
  const groups = [
    { item_id: "pr-1", lens_id: "correctness", draws: [[f(A)], [f(B)]] },
    { item_id: "pr-2", lens_id: "correctness", draws: [[f(A)], [f(OTHER)]] },
  ];
  const { aggregate } = computeSampleCount(groups);
  assert.equal(aggregate.n_blocking_defects, 3);
  near(aggregate.curve[0].blocking_recall, 2 / 3);
  assert.equal(aggregate.curve[0].n_defects, 3);
  near(aggregate.curve[1].blocking_recall, 1);
  near(aggregate.marginal_second_sample, 1 / 3);
  assert.equal(aggregate.n_singleton_blocking, 2);
  assert.equal(aggregate.singleton_blocking[0].item_id, "pr-2");
});

test("computeSampleCount: groups thin out at high N and the count says so", () => {
  const groups = [
    { item_id: "pr-1", lens_id: "correctness", draws: [[f(A)], [f(B)]] },              // D=2
    { item_id: "pr-2", lens_id: "correctness", draws: [[f(A)], [f(B)], [f(C)]] },      // D=3
  ];
  const { aggregate } = computeSampleCount(groups);
  assert.equal(aggregate.curve[0].n_groups, 2);
  assert.equal(aggregate.curve[2].n_groups, 1);   // only pr-2 reaches N=3
});

test("computeSampleCount: contested flip rate is not diluted by never-blocking groups", () => {
  const groups = [
    { item_id: "pr-1", lens_id: "correctness", draws: [[f(A)], [], [], []] },   // contested
    { item_id: "pr-2", lens_id: "docs", draws: [[], [], [], []] },              // silent
    { item_id: "pr-3", lens_id: "security", draws: [[], [], [], []] },          // silent
  ];
  const { aggregate } = computeSampleCount(groups);
  assert.equal(aggregate.n_contested_groups, 1);
  near(aggregate.curve[0].proxy_flip_rate, 0.25 / 3);        // diluted across all 3
  near(aggregate.curve[0].proxy_flip_rate_contested, 0.25);  // the honest figure
});

// --- envelope projection ----------------------------------------------------

test("envelopesToGroups: pools per_sample across replicates into one draw pool", () => {
  const env = (runId, perSample) => ({
    run_id: runId, stage_id: "detection", status: "ok",
    fixture_ref: "pr-493::detection::correctness", item_id: "pr-493",
    output: { per_sample: perSample },
  });
  const groups = envelopesToGroups([env("r1", [[f(A)], [f(B)]]), env("r2", [[f(C)], []])]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].item_id, "pr-493");
  assert.equal(groups[0].lens_id, "correctness");
  assert.equal(groups[0].draws.length, 4);   // 2 replicates x samples:2
});

test("envelopesToGroups: errored replays are dropped, never read as a clean draw", () => {
  const groups = envelopesToGroups([
    { stage_id: "detection", status: "ok", fixture_ref: "i::detection::correctness", item_id: "i",
      output: { per_sample: [[f(A)], [f(B)]] } },
    { stage_id: "detection", status: "error", fixture_ref: "i::detection::correctness", item_id: "i", output: null },
    { stage_id: "verifier", status: "ok", fixture_ref: "i::verifier::correctness::fresh::k", item_id: "i",
      output: { per_sample: [[f(A)]] } },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].draws.length, 2);
});

test("envelopesToGroups: nothing usable → empty, not a phantom group", () => {
  assert.deepEqual(envelopesToGroups([]), []);
  assert.deepEqual(envelopesToGroups([{ stage_id: "detection", status: "error" }]), []);
});
