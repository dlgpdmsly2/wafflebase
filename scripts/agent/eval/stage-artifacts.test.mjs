import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_ARTIFACT_VERSION, STAGES, RESERVED_STAGES,
  validateStageArtifact, assertStageArtifact, stageInstanceKey, findingKey,
  isBlobRef, isFinding, isCounts, isConfidenceCounts, isChangedContext,
} from "./stage-artifacts.mjs";

// --- fixture builders (a VALID artifact per stage; tests mutate copies) ------

const REF = { sha256: "sha256:" + "a".repeat(64), bytes: 128 };
const PROV = {
  run_id: "2026-07-29T00-00-00__baseline-opus-s2",
  config_hash: "sha256:beef",
  sdk_version: "0.3.217",
  model: "claude-opus-5",
  captured_at: "2026-07-29T00:00:00.000Z",
};
const FINDING = { severity: "major", confidence: "high", file: "packages/x/y.ts", summary: "boom", evidence: "line 42" };
const COUNTS = { critical: 0, major: 1, minor: 0, nit: 0 };
const CONF_COUNTS = { high: 1, medium: 0, low: 0, unknown: 0 };

function detection() {
  return {
    schema_version: STAGE_ARTIFACT_VERSION, item_id: "pr-521", stage: "detection",
    instance: { lens_id: "correctness" }, provenance: { ...PROV },
    input: { rubric: { ...REF }, diff: { ...REF }, issue: null, changed_files: { ...REF }, repo_commit: "abc123", samples: 2 },
    output: {
      union: [{ ...FINDING }], per_sample: [[{ ...FINDING }], [{ ...FINDING }]],
      samples_run: 2, samples_ok: 2, agreement: "identical",
      severity_counts: { ...COUNTS }, confidence_counts: { ...CONF_COUNTS },
    },
  };
}
function verifier() {
  return {
    schema_version: STAGE_ARTIFACT_VERSION, item_id: "pr-521", stage: "verifier",
    instance: { lens_id: "correctness", population: "fresh", finding_key: findingKey(FINDING) },
    provenance: { ...PROV },
    input: {
      finding: { ...FINDING }, rubric: { ...REF }, changed_files: { ...REF },
      changed_context: { authoritative: true, total: 3, listed_count: 3 },
      repo_commit: "abc123", model: "claude-opus-5", max_turns: 8,
    },
    output: {
      decision: { verdict: "refuted", confidence: "high", reason: "guarded", refutationGround: "already-guarded", groundedIn: ["packages/x/y.ts:42"] },
      error: null, dropped: true,
    },
  };
}
function gate() {
  return {
    schema_version: STAGE_ARTIFACT_VERSION, item_id: "pr-521", stage: "gate",
    instance: {}, provenance: { ...PROV },
    input: { lenses: [{ lens_id: "correctness", blocking: true, applicable: true, kept: [{ ...FINDING }], infra_error: null }] },
    output: { per_lens: [{ lens_id: "correctness", conclusion: "failure" }], verdict: "block" },
  };
}

const ok = (art) => assert.deepEqual(validateStageArtifact(art), { valid: true, errors: [] });
const hasErr = (art, needle) => {
  const { valid, errors } = validateStageArtifact(art);
  assert.equal(valid, false, `expected invalid, got valid: ${JSON.stringify(art)}`);
  assert.ok(errors.some((e) => e.includes(needle)), `expected an error containing "${needle}", got:\n${errors.join("\n")}`);
};

// --- predicates --------------------------------------------------------------

test("isBlobRef: requires sha256:<64hex> + non-neg int bytes", () => {
  assert.ok(isBlobRef({ sha256: "sha256:" + "0".repeat(64), bytes: 0 }));
  assert.ok(!isBlobRef({ sha256: "sha256:xyz", bytes: 1 }));      // not hex
  assert.ok(!isBlobRef({ sha256: "a".repeat(64), bytes: 1 }));    // missing prefix
  assert.ok(!isBlobRef({ sha256: "sha256:" + "a".repeat(64) }));  // missing bytes
  assert.ok(!isBlobRef({ sha256: "sha256:" + "a".repeat(64), bytes: -1 }));
});

test("isFinding: severity+summary required; confidence/file/evidence optional", () => {
  assert.ok(isFinding({ severity: "major", summary: "x" }));           // script-synthesised (no confidence)
  assert.ok(isFinding({ severity: "wat", confidence: "high", summary: "" })); // severity string as-produced; empty summary ok
  assert.ok(!isFinding({ summary: "x" }));                             // no severity
  assert.ok(!isFinding({ severity: "major" }));                        // no summary
  assert.ok(!isFinding({ severity: "major", summary: 7 }));            // summary not a string
});

test("isCounts / isConfidenceCounts / isChangedContext", () => {
  assert.ok(isCounts({ critical: 0, major: 0, minor: 0, nit: 0 }));
  assert.ok(!isCounts({ critical: 0, major: 0, minor: 0 }));          // missing nit
  assert.ok(isConfidenceCounts({ high: 0, medium: 0, low: 0, unknown: 0 }));
  assert.ok(!isConfidenceCounts({ high: 0, medium: 0, low: 0 }));     // missing unknown
  assert.ok(isChangedContext({ authoritative: false, total: 0, listed_count: 0 }));
  assert.ok(!isChangedContext({ authoritative: "yes", total: 0, listed_count: 0 }));
});

// --- happy paths -------------------------------------------------------------

test("valid detection / verifier / gate artifacts pass", () => {
  ok(detection());
  ok(verifier());
  ok(gate());
});

test("verifier prior-round population + repo_commit null both valid", () => {
  const v = verifier();
  v.instance.population = "prior-round";
  v.input.repo_commit = null; // permitted (diff-only), though low-fidelity for the verifier
  ok(v);
});

test("verifier error output (no decision) is valid and keeps the finding", () => {
  const v = verifier();
  v.output = { decision: null, error: { message: "api-error", kind: "infra" }, dropped: false };
  ok(v);
});

test("detection with zero successful samples + disjoint agreement is valid", () => {
  const d = detection();
  d.output = { union: [], per_sample: [], samples_run: 2, samples_ok: 0, agreement: "single",
    severity_counts: { ...COUNTS, major: 0 }, confidence_counts: { ...CONF_COUNTS, high: 0 } };
  ok(d);
});

// --- envelope-level rejections ----------------------------------------------

test("non-object / wrong schema_version / missing item_id / bad provenance rejected", () => {
  assert.equal(validateStageArtifact(null).valid, false);
  assert.equal(validateStageArtifact("x").valid, false);
  hasErr({ ...detection(), schema_version: "stage-artifacts/v2" }, "schema_version");
  hasErr({ ...detection(), item_id: "" }, "item_id");
  const badProv = detection(); badProv.provenance = { run_id: "r" }; // missing config_hash/sdk_version/captured_at
  hasErr(badProv, "provenance.config_hash");
});

test("reserved stages (rebuttal/adjudicator) rejected with a 'RESERVED' message", () => {
  assert.deepEqual(RESERVED_STAGES, ["rebuttal", "adjudicator"]);
  for (const s of RESERVED_STAGES) hasErr({ ...gate(), stage: s }, "RESERVED");
});

test("unknown stage rejected", () => {
  hasErr({ ...gate(), stage: "nonsense" }, "stage: one of");
  assert.deepEqual(STAGES, ["detection", "verifier", "gate"]);
});

// --- detection-specific ------------------------------------------------------

test("detection: missing lens_id, bad BlobRef, samples<1, missing confidence_counts", () => {
  const d1 = detection(); d1.instance = {}; hasErr(d1, "instance.lens_id");
  const d2 = detection(); d2.input.diff = { sha256: "nope" }; hasErr(d2, "input.diff");
  const d3 = detection(); d3.input.samples = 0; hasErr(d3, "input.samples");
  const d4 = detection(); delete d4.output.confidence_counts; hasErr(d4, "confidence_counts");
  const d5 = detection(); d5.output.agreement = "mostly"; hasErr(d5, "agreement");
  const d6 = detection(); d6.output.per_sample = [[{ severity: "major" }], "nope"]; hasErr(d6, "per_sample");
});

// --- verifier-specific (the #573 shape) -------------------------------------

test("verifier: the independence guard rejects an input that carries a diff", () => {
  const v = verifier(); v.input.diff = { ...REF };
  hasErr(v, "input.diff: MUST be absent");
});

test("verifier: instance requires population + finding_key", () => {
  const v1 = verifier(); delete v1.instance.population; hasErr(v1, "instance.population");
  const v2 = verifier(); v2.instance.population = "later"; hasErr(v2, "instance.population");
  const v3 = verifier(); v3.instance.finding_key = ""; hasErr(v3, "instance.finding_key");
});

test("verifier: input requires changed_context, model, max_turns≥1", () => {
  const v1 = verifier(); delete v1.input.changed_context; hasErr(v1, "changed_context");
  const v2 = verifier(); v2.input.max_turns = 0; hasErr(v2, "max_turns");
  const v3 = verifier(); v3.input.model = ""; hasErr(v3, "input.model");
});

test("verifier: decision requires refutationGround (enum) + groundedIn (string[])", () => {
  const v1 = verifier(); v1.output.decision.refutationGround = "made-up"; hasErr(v1, "refutationGround");
  const v2 = verifier(); delete v2.output.decision.refutationGround; hasErr(v2, "refutationGround");
  const v3 = verifier(); v3.output.decision.groundedIn = "packages/x.ts:1"; hasErr(v3, "groundedIn"); // must be an array
  const v4 = verifier(); v4.output.decision.groundedIn = [42]; hasErr(v4, "groundedIn");
  const v5 = verifier(); v5.output.decision.verdict = "maybe"; hasErr(v5, "verdict");
});

test("verifier: exactly one of {decision, error}; dropped must be boolean", () => {
  const both = verifier(); both.output.error = { message: "x" }; hasErr(both, "exactly one of");
  const neither = verifier(); neither.output = { decision: null, error: null, dropped: false }; hasErr(neither, "exactly one of");
  const noDrop = verifier(); delete noDrop.output.dropped; hasErr(noDrop, "output.dropped");
});

// --- gate-specific -----------------------------------------------------------

test("gate: needs a non-empty lenses[] and a block/approve verdict", () => {
  const g1 = gate(); g1.input.lenses = []; hasErr(g1, "input.lenses");
  const g2 = gate(); g2.input.lenses[0].blocking = "yes"; hasErr(g2, "blocking");
  const g3 = gate(); g3.output.verdict = "reject"; hasErr(g3, "output.verdict");
  const g4 = gate(); g4.output.per_lens[0].conclusion = "meh"; hasErr(g4, "conclusion");
});

// --- keys + assert wrapper ---------------------------------------------------

test("stageInstanceKey: stable item×stage×instance address per stage", () => {
  assert.equal(stageInstanceKey(detection()), "pr-521::detection::correctness");
  assert.equal(stageInstanceKey(verifier()), `pr-521::verifier::correctness::fresh::${findingKey(FINDING)}`);
  assert.equal(stageInstanceKey(gate()), "pr-521::gate");
});

test("findingKey: matches review-panel's file::lowercased-trimmed-summary key", () => {
  assert.equal(findingKey({ file: "A/B.ts", summary: "  Boom  " }), "A/B.ts::boom");
  assert.equal(findingKey({ summary: "X" }), "::x");            // missing file → empty segment
  assert.equal(findingKey({}), "::");
});

test("assertStageArtifact: returns the artifact when valid, throws (listing errors) when not", () => {
  const d = detection();
  assert.equal(assertStageArtifact(d), d);
  assert.throws(() => assertStageArtifact({ ...d, stage: "rebuttal" }), /invalid stage artifact[\s\S]*RESERVED/);
});
