import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitFsStore } from "./store.mjs";
import { findingKey } from "./stage-artifacts.mjs";
import {
  verifierDecision, confusionCell, metricsFromMatrix, effectiveness,
  computeVerifierValidity, joinVerifierRecords,
} from "./verifier-validity.mjs";

const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

// A minimal verifier artifact; `dropped` + optional error/decision.
const vArt = (over = {}) => ({
  schema_version: "stage-artifacts/v1", stage: "verifier", item_id: over.item_id ?? "pr-1",
  instance: { lens_id: "correctness", population: over.population ?? "fresh", finding_key: over.finding_key ?? "a.ts::x" },
  output: over.output ?? { decision: { verdict: "confirmed" }, error: null, dropped: over.dropped ?? false },
});

test("verifierDecision: keep/drop, excludes errored + non-verifier + malformed", () => {
  assert.equal(verifierDecision(vArt({ dropped: false })), "keep");
  assert.equal(verifierDecision(vArt({ dropped: true })), "drop");
  assert.equal(verifierDecision(vArt({ output: { decision: null, error: { message: "429" }, dropped: false } })), null); // errored
  assert.equal(verifierDecision({ ...vArt(), stage: "detection" }), null); // wrong stage
  assert.equal(verifierDecision(vArt({ output: { decision: {}, error: null, dropped: "nope" } })), null); // bad dropped
  assert.equal(verifierDecision(null), null);
});

test("confusionCell: four cells + null guards", () => {
  assert.equal(confusionCell("keep", true), "keep_real");
  assert.equal(confusionCell("keep", false), "keep_fake");
  assert.equal(confusionCell("drop", true), "drop_real");
  assert.equal(confusionCell("drop", false), "drop_fake");
  assert.equal(confusionCell("keep", null), null);
  assert.equal(confusionCell(null, true), null);
});

test("metricsFromMatrix: worked example + null on empty denominators", () => {
  // keep_real=5, keep_fake=1, drop_real=0, drop_fake=4  (total 10)
  const m = metricsFromMatrix({ keep_real: 5, keep_fake: 1, drop_real: 0, drop_fake: 4 });
  approx(m.kept_precision, 5 / 6);     // of kept, fraction real
  approx(m.keep_recall, 1);            // no real defect dropped
  approx(m.drop_specificity, 4 / 5);   // of fakes, fraction dropped
  approx(m.input_precision, 5 / 10);   // precision of findings reaching verifier
  approx(m.precision_lift, 5 / 6 - 0.5);
  assert.equal(m.n, 10);
  // empty matrix → all ratios null (never 0, which would read as "perfectly wrong")
  const z = metricsFromMatrix({ keep_real: 0, keep_fake: 0, drop_real: 0, drop_fake: 0 });
  assert.equal(z.kept_precision, null);
  assert.equal(z.precision_lift, null);
  assert.equal(z.n, 0);
});

test("effectiveness: effective / net-harmful / mixed / no-data", () => {
  assert.equal(effectiveness(metricsFromMatrix({ keep_real: 5, keep_fake: 1, drop_real: 0, drop_fake: 4 })), "effective");   // recall 1, spec 0.8
  assert.equal(effectiveness(metricsFromMatrix({ keep_real: 2, keep_fake: 3, drop_real: 2, drop_fake: 0 })), "net-harmful"); // lift<0
  assert.equal(effectiveness(metricsFromMatrix({ keep_real: 3, keep_fake: 1, drop_real: 1, drop_fake: 5 })), "mixed");       // recall 0.75<0.8
  assert.equal(effectiveness(metricsFromMatrix({ keep_real: 0, keep_fake: 0, drop_real: 0, drop_fake: 0 })), "no-data");
});

test("effectiveness: a rubber stamp (safe recall, sub-majority specificity) is NOT effective — the #521 shape", () => {
  // The real pilot cell: n=6, kept 3/3 reals (recall 1.0) but only dropped 1 of 3
  // fakes (spec 0.33). precision_lift is a positive +0.10, which the old scheme read
  // as "effective". The value axis catches it: it waves the majority of junk through.
  const m = metricsFromMatrix({ keep_real: 3, keep_fake: 2, drop_real: 0, drop_fake: 1 });
  approx(m.keep_recall, 1);          // preserved every real defect it saw → safe
  approx(m.drop_specificity, 1 / 3); // dropped only 1 of 3 hallucinations → sub-majority
  assert.ok(m.precision_lift > 0);   // +0.10 — positive, yet not enough to earn "effective"
  assert.equal(effectiveness(m), "rubber-stamp");
});

test("effectiveness: safe recall but never faced junk → insufficient, not net-harmful", () => {
  // Only real findings reached it and it kept them: recall 1, specificity null,
  // precision_lift 0 (kept set == input set). It did no harm but proved no value.
  const m = metricsFromMatrix({ keep_real: 4, keep_fake: 0, drop_real: 0, drop_fake: 0 });
  assert.equal(m.drop_specificity, null);
  assert.equal(m.precision_lift, 0);
  assert.equal(effectiveness(m), "insufficient");
});

test("effectiveness: keeps reals AND drops a majority of junk → effective", () => {
  // spec exactly at the 0.5 floor (drops 1 of 2 fakes), recall 1 → clears the bar.
  const m = metricsFromMatrix({ keep_real: 3, keep_fake: 1, drop_real: 0, drop_fake: 1 });
  approx(m.drop_specificity, 0.5);
  assert.equal(effectiveness(m), "effective");
});

test("computeVerifierValidity: matrix, population slice, exclusion discipline", () => {
  const records = [
    { item_id: "pr-1", finding_key: "a::1", population: "fresh", decision: "keep", is_real: true },   // keep_real
    { item_id: "pr-1", finding_key: "a::2", population: "fresh", decision: "keep", is_real: false },  // keep_fake
    { item_id: "pr-1", finding_key: "a::3", population: "fresh", decision: "drop", is_real: false },  // drop_fake
    { item_id: "pr-2", finding_key: "b::1", population: "prior-round", decision: "drop", is_real: true }, // drop_real (#521 shape)
    { item_id: "pr-2", finding_key: "b::2", population: "prior-round", decision: null, is_real: true },   // EXCLUDED errored
    { item_id: "pr-2", finding_key: "b::3", population: "fresh", decision: "keep", is_real: null },       // EXCLUDED unlabeled
  ];
  const r = computeVerifierValidity(records);
  assert.equal(r.n_scored, 4);
  assert.deepEqual(r.overall.matrix, { keep_real: 1, keep_fake: 1, drop_real: 1, drop_fake: 1 });
  assert.equal(r.excluded.errored, 1);
  assert.equal(r.excluded.unlabeled, 1);
  // slices
  assert.deepEqual(r.by_population.fresh.matrix, { keep_real: 1, keep_fake: 1, drop_real: 0, drop_fake: 1 });
  assert.deepEqual(r.by_population["prior-round"].matrix, { keep_real: 0, keep_fake: 0, drop_real: 1, drop_fake: 0 });
});

test("the #521 cell: a prior-round drop of a real finding is surfaced as damage", () => {
  const records = [{ item_id: "pr-521", finding_key: "arguments.ts::blank-skip", population: "prior-round", decision: "drop", is_real: true }];
  const r = computeVerifierValidity(records);
  assert.equal(r.by_population["prior-round"].matrix.drop_real, 1);
  assert.equal(r.overall.real_drops.length, 1);
  assert.equal(r.overall.real_drops[0].item_id, "pr-521");
  assert.equal(r.overall.real_drops[0].population, "prior-round");
});

test("joinVerifierRecords: end-to-end store join reproduces the #521 false-negative", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verifier-validity-"));
  try {
    const store = new GitFsStore(root);
    const CV = "2026-07-28-pilot";
    const fkey = findingKey({ file: "packages/sheets/src/formula/arguments.ts", summary: "MIN/MAX over all-blank range returns #NUM!" });
    store.putFindingLabel(CV, "pr-521", fkey, { is_real: true, should_verifier_keep: true, severity: "major" });
    // one hallucination the verifier correctly dropped, plus the real defect it wrongly dropped
    const fakeKey = findingKey({ file: "x.ts", summary: "imagined bug" });
    store.putFindingLabel(CV, "pr-521", fakeKey, { is_real: false });

    const artifacts = [
      vArt({ item_id: "pr-521", finding_key: fkey, population: "prior-round", dropped: true }),  // drop_real ← #521
      vArt({ item_id: "pr-521", finding_key: fakeKey, population: "fresh", dropped: true }),     // drop_fake ← correct
      vArt({ item_id: "pr-521", finding_key: "unlabeled::finding", population: "fresh", dropped: false }), // unlabeled → excluded
    ];
    const records = joinVerifierRecords(store, CV, artifacts);
    const r = computeVerifierValidity(records);

    assert.equal(r.overall.matrix.drop_real, 1);
    assert.equal(r.overall.matrix.drop_fake, 1);
    assert.equal(r.excluded.unlabeled, 1);
    assert.equal(r.overall.real_drops[0].finding_key, fkey);
    // dropped everything real that reached it → keep_recall 0, drop-heavy → net-harmful
    assert.equal(r.overall.metrics.keep_recall, 0);
    assert.equal(r.overall.effectiveness, "net-harmful");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("joinVerifierRecords: V2 matcher joins a REWORDED label that exact-key misses", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verifier-validity-v2-"));
  try {
    const store = new GitFsStore(root);
    const CV = "cv1";
    // A label written against a DIFFERENT wording of the same defect (the pr-521
    // seed situation: historical product-panel phrasing vs a fresh capture).
    const labelKey = findingKey({
      file: "packages/sheets/src/formula/arguments.ts",
      summary: "blank-skip makes MIN/MAX over an all-blank range return #NUM! instead of 0",
    });
    store.putFindingLabel(CV, "pr-521", labelKey, { is_real: true, severity: "major", kind: "correctness" });

    // The captured artifact says the same thing in other words → different key.
    const art = {
      schema_version: "stage-artifacts/v1", stage: "verifier", item_id: "pr-521",
      instance: {
        lens_id: "correctness", population: "fresh",
        finding_key: "packages/sheets/src/formula/arguments.ts::blank-cell skipping in `arguments.iterate` makes min and max over an all-blank range return #num!",
      },
      input: { finding: {
        file: "packages/sheets/src/formula/arguments.ts",
        summary: "Blank-cell skipping in `Arguments.iterate` makes MIN and MAX over an all-blank range return #NUM!",
        evidence: "`Arguments.iterate` skips blanks so MIN/MAX see an empty set",
      } },
      output: { decision: { verdict: "confirmed" }, error: null, dropped: false },
    };

    // exact-key only → no join (the documented 0/6 failure)
    const exactOnly = joinVerifierRecords(store, CV, [art], { matcher: false });
    assert.equal(exactOnly[0].is_real, null);
    assert.equal(exactOnly[0].join_method, "none");

    // with the matcher → joins, and records how
    const withMatcher = joinVerifierRecords(store, CV, [art]);
    assert.equal(withMatcher[0].is_real, true);
    assert.equal(withMatcher[0].join_method, "matcher");
    assert.equal(withMatcher[0].matched_label_key, labelKey);
    assert.ok(withMatcher[0].match_score > 0.5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("joinVerifierRecords: exact key stays the fast path and an unrelated finding never joins", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verifier-validity-v2b-"));
  try {
    const store = new GitFsStore(root);
    const CV = "cv1";
    const key = findingKey({ file: "a.ts", summary: "exact wording" });
    store.putFindingLabel(CV, "pr-1", key, { is_real: true });

    const exactArt = vArt({ item_id: "pr-1", finding_key: key, dropped: false });
    assert.equal(joinVerifierRecords(store, CV, [exactArt])[0].join_method, "exact");

    // A finding about a different file with no shared symbols/location → no join,
    // not even a maybe: the matcher must never invent ground truth.
    const unrelated = {
      ...vArt({ item_id: "pr-1", finding_key: "zzz/other.ts::a totally different rendering problem", dropped: false }),
      input: { finding: { file: "zzz/other.ts", summary: "a totally different rendering problem", evidence: "" } },
    };
    const r = joinVerifierRecords(store, CV, [unrelated])[0];
    assert.equal(r.is_real, null);
    assert.equal(r.join_method, "none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
