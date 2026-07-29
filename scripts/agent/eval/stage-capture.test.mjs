import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStageArtifacts } from "./stage-capture.mjs";
import { validateStageArtifact, stageInstanceKey, findingKey } from "./stage-artifacts.mjs";

const REF = { sha256: "sha256:" + "a".repeat(64), bytes: 10 };

// A captured reviewer payload exercising: a lens with 2 disagreeing samples + a
// confirmed fresh verdict, a dropped prior-round verdict, and an errored verifier;
// a clean lens (found nothing); a skipped lens; an infra-failed lens.
function captured() {
  const boom = { severity: "major", confidence: "high", file: "a.ts", summary: "boom", evidence: "e" };
  return {
    panel: [
      { id: "correctness", title: "Correctness", blocking: true, applicable: true, conclusion: "failure", valid: true },
      { id: "security", title: "Security", blocking: true, applicable: true, conclusion: "success", valid: true },
      { id: "design-fit", title: "Design-fit", blocking: true, applicable: false, conclusion: "skipped", valid: true },
      { id: "test-adequacy", title: "Test-adequacy", blocking: true, applicable: true, conclusion: "failure", valid: false, infraError: "quota" },
    ],
    findings: [
      { lens: "correctness", severity: "major", file: "a.ts", summary: "boom", evidence: "e" },
      { lens: "test-adequacy", severity: "major", summary: "Review could not run — quota" },
    ],
    stageDetail: {
      correctness: {
        samples: [
          [boom],
          [{ severity: "major", confidence: "medium", file: "a.ts", summary: "boom" }, { severity: "minor", confidence: "low", file: "b.ts", summary: "nit" }],
        ],
        verifications: [
          { population: "fresh", finding: boom, verdict: { verdict: "confirmed", confidence: "low", reason: "present", refutationGround: "none", groundedIn: [] }, dropped: false },
          { population: "prior-round", finding: { severity: "critical", confidence: "high", file: "c.ts", summary: "old bug" }, verdict: { verdict: "refuted", confidence: "high", reason: "fixed", refutationGround: "not-present", groundedIn: ["c.ts:10"] }, dropped: true },
          { population: "fresh", finding: { severity: "major", summary: "errored one" }, verdict: null, dropped: false },
        ],
      },
      security: { samples: [[], []], verifications: [] },
      // design-fit: skipped → no stage-detail. test-adequacy: infra-failed → no stage-detail.
    },
  };
}

const ctx = () => ({
  item_id: "pr-1",
  provenance: { run_id: "r1", config_hash: "sha256:abc", sdk_version: "0.3.217", captured_at: "2026-07-29T00:00:00.000Z" },
  repo_commit: "deadbeef",
  changed_files: ["a.ts", "b.ts", "c.ts"],
  refs: { diff: REF, issue: null, changed_files: REF, rubricByLens: { correctness: REF, security: REF, "design-fit": REF, "test-adequacy": REF } },
  lensMeta: {
    correctness: { model: "claude-opus-5", samples: 2, title: "Correctness", needsIssueSpec: false },
    security: { model: "claude-opus-5", samples: 2, title: "Security", needsIssueSpec: false },
    "design-fit": { model: "claude-opus-5", samples: 2, title: "Design-fit", needsIssueSpec: true },
    "test-adequacy": { model: "claude-opus-5", samples: 2, title: "Test-adequacy", needsIssueSpec: false },
  },
});

test("every produced artifact validates (buildStageArtifacts self-asserts; re-check anyway)", () => {
  const arts = buildStageArtifacts(captured(), ctx());
  for (const a of arts) assert.deepEqual(validateStageArtifact(a), { valid: true, errors: [] });
});

test("produces detection×2 + verifier×3 + gate×1, all uniquely keyed", () => {
  const arts = buildStageArtifacts(captured(), ctx());
  const byStage = (s) => arts.filter((a) => a.stage === s);
  assert.equal(byStage("detection").length, 2); // correctness + security (skipped/failed lenses produce none)
  assert.equal(byStage("verifier").length, 3);
  assert.equal(byStage("gate").length, 1);
  const keys = arts.map(stageInstanceKey);
  assert.equal(new Set(keys).size, keys.length, `keys not unique: ${keys}`);
});

test("detection: union deduped, partial agreement, severity/confidence counts", () => {
  const d = buildStageArtifacts(captured(), ctx()).find((a) => a.stage === "detection" && a.instance.lens_id === "correctness");
  assert.equal(d.output.union.length, 2);                         // a.ts::boom + b.ts::nit
  assert.equal(d.output.agreement, "partial");                   // samples share boom, differ on nit
  assert.deepEqual(d.output.severity_counts, { critical: 0, major: 1, minor: 1, nit: 0 });
  assert.deepEqual(d.output.confidence_counts, { high: 1, medium: 0, low: 1, unknown: 0 }); // boom keeps sample-1 (high)
  assert.equal(d.output.samples_run, 2);
  assert.equal(d.output.samples_ok, 2);
  assert.equal(d.input.repo_commit, "deadbeef");
  // self-contained replay params
  assert.equal(d.input.model, "claude-opus-5");
  assert.equal(d.input.title, "Correctness");
  assert.equal(d.input.needs_issue_spec, false);
});

test("detection: a clean lens yields an empty union with identical agreement", () => {
  const d = buildStageArtifacts(captured(), ctx()).find((a) => a.stage === "detection" && a.instance.lens_id === "security");
  assert.deepEqual(d.output.union, []);
  assert.equal(d.output.agreement, "identical");
  assert.equal(d.output.samples_ok, 2);
});

test("verifier: fresh confirmed / prior-round dropped / errored → error output", () => {
  const vs = buildStageArtifacts(captured(), ctx()).filter((a) => a.stage === "verifier");
  const fresh = vs.find((a) => a.instance.population === "fresh" && a.instance.finding_key === findingKey({ file: "a.ts", summary: "boom" }));
  assert.equal(fresh.output.decision.verdict, "confirmed");
  assert.equal(fresh.output.dropped, false);
  assert.equal(fresh.output.error, null);
  assert.equal(fresh.input.max_turns, 8);
  assert.equal("diff" in fresh.input, false);                   // independence: no diff on the verifier
  assert.deepEqual(fresh.input.changed_context, { authoritative: true, total: 3, listed_count: 3 });

  const prior = vs.find((a) => a.instance.population === "prior-round");
  assert.equal(prior.output.dropped, true);
  assert.equal(prior.output.decision.refutationGround, "not-present");
  assert.deepEqual(prior.output.decision.groundedIn, ["c.ts:10"]);

  const errored = vs.find((a) => a.instance.finding_key === findingKey({ summary: "errored one" }));
  assert.equal(errored.output.decision, null);
  assert.equal(errored.output.error.kind, "no-verdict");
  assert.equal(errored.output.dropped, false);
});

test("gate: all lenses present; block verdict; infra + skipped carried", () => {
  const g = buildStageArtifacts(captured(), ctx()).find((a) => a.stage === "gate");
  assert.equal(g.input.lenses.length, 4);
  assert.equal(g.output.verdict, "block");                      // correctness applicable+blocking+failure
  const corr = g.input.lenses.find((l) => l.lens_id === "correctness");
  assert.equal(corr.kept.length, 1);
  const ta = g.input.lenses.find((l) => l.lens_id === "test-adequacy");
  assert.equal(ta.infra_error, "quota");
  const df = g.input.lenses.find((l) => l.lens_id === "design-fit");
  assert.equal(df.applicable, false);
  assert.deepEqual(df.kept, []);
  assert.deepEqual(g.instance, {});
});

test("gate: approve when no applicable blocking lens requested changes", () => {
  const c = captured();
  c.panel = c.panel.map((p) => (p.id === "correctness" ? { ...p, conclusion: "success" } : p));
  c.panel = c.panel.map((p) => (p.id === "test-adequacy" ? { ...p, conclusion: "success", valid: true, infraError: undefined } : p));
  c.findings = []; // nothing kept
  const g = buildStageArtifacts(c, ctx()).find((a) => a.stage === "gate");
  assert.equal(g.output.verdict, "approve");
});
