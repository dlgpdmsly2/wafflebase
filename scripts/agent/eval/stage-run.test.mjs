import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitFsStore } from "./store.mjs";
import { gateAdapter, detectionAdapter, verifierAdapter, resolveBlobRef, STAGE_ADAPTERS } from "./stage-adapters.mjs";
import { runStage } from "./stage-run.mjs";
import { validateStageArtifact, stageInstanceKey } from "./stage-artifacts.mjs";

function tmpStore() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-eval-stagerun-"));
  return { store: new GitFsStore(root), root };
}

const gateFixture = (item, lenses, verdict, per_lens) => ({
  schema_version: "stage-artifacts/v1", item_id: item, stage: "gate", instance: {},
  provenance: { run_id: "R1", config_hash: "sha256:cfg", sdk_version: "0.3.217", captured_at: "T" },
  input: { lenses },
  output: { per_lens, verdict },
});

const blockFx = gateFixture(
  "pr-block",
  [
    { lens_id: "correctness", blocking: true, applicable: true, kept: [{ severity: "major", summary: "boom" }], infra_error: null },
    { lens_id: "docs", blocking: false, applicable: true, kept: [{ severity: "critical", summary: "advisory only" }], infra_error: null },
    { lens_id: "design-fit", blocking: true, applicable: false, kept: [], infra_error: null },
  ],
  "block",
  [{ lens_id: "correctness", conclusion: "failure" }, { lens_id: "docs", conclusion: "success" }, { lens_id: "design-fit", conclusion: "skipped" }],
);
const approveFx = gateFixture(
  "pr-approve",
  [
    { lens_id: "correctness", blocking: true, applicable: true, kept: [{ severity: "minor", summary: "nit" }], infra_error: null },
    { lens_id: "security", blocking: true, applicable: true, kept: [], infra_error: null },
  ],
  "approve",
  [{ lens_id: "correctness", conclusion: "success" }, { lens_id: "security", conclusion: "success" }],
);

test("hand-built gate fixtures are schema-valid", () => {
  for (const fx of [blockFx, approveFx]) assert.deepEqual(validateStageArtifact(fx), { valid: true, errors: [] });
});

test("gateAdapter: pure recompute reproduces the captured verdict + per-lens conclusions", async () => {
  for (const fx of [blockFx, approveFx]) {
    const { output, sessionLog } = await gateAdapter.runReplica(gateAdapter.prepareInput(fx));
    assert.deepEqual(output, fx.output);      // determinism: replay == captured
    assert.deepEqual(sessionLog, []);          // pure → no cost
  }
});

test("gateAdapter: advisory (non-blocking) + skipped lenses never drive a block", async () => {
  // a blocking critical, but on a NON-blocking lens, plus a skipped blocking lens
  const fx = gateFixture("pr-x",
    [{ lens_id: "docs", blocking: false, applicable: true, kept: [{ severity: "critical", summary: "x" }], infra_error: null },
     { lens_id: "correctness", blocking: true, applicable: false, kept: [{ severity: "critical", summary: "y" }], infra_error: null }],
    "approve", [{ lens_id: "docs", conclusion: "success" }, { lens_id: "correctness", conclusion: "skipped" }]);
  const { output } = await gateAdapter.runReplica(gateAdapter.prepareInput(fx));
  assert.equal(output.verdict, "approve");
});

test("runStage: replays every gate fixture, envelopes carry stage_id + fixture_ref, cost 0", async () => {
  const { store, root } = tmpStore();
  try {
    for (const fx of [blockFx, approveFx]) store.putStageArtifact("SV", stageInstanceKey(fx), fx);
    const s = await runStage({ store, stageVersion: "SV", stage: "gate", runId: "SR1", adapter: gateAdapter, timestamp: "T0" });
    assert.equal(s.total, 2);
    assert.equal(s.ok, 2);
    assert.equal(s.cost_usd, 0);

    const envs = store.listStageRun("SV", "SR1");
    assert.equal(envs.length, 2);
    for (const e of envs) {
      assert.equal(e.stage_id, "gate");
      assert.equal(e.status, "ok");
      assert.ok(["pr-block", "pr-approve"].includes(e.item_id));
      assert.ok(["block", "approve"].includes(e.output.verdict));
    }
    // the block fixture's replay reproduces its captured verdict, addressable by fixture_ref
    const blockEnv = store.getStageRun("SV", "SR1", stageInstanceKey(blockFx));
    assert.equal(blockEnv.output.verdict, "block");
    assert.equal(blockEnv.fixture_ref, stageInstanceKey(blockFx));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runStage: resumable — a second run_id pass re-does nothing already recorded", async () => {
  const { store, root } = tmpStore();
  try {
    for (const fx of [blockFx, approveFx]) store.putStageArtifact("SV", stageInstanceKey(fx), fx);
    await runStage({ store, stageVersion: "SV", stage: "gate", runId: "SR1", adapter: gateAdapter, timestamp: "T0" });
    const again = await runStage({ store, stageVersion: "SV", stage: "gate", runId: "SR1", adapter: gateAdapter, timestamp: "T1" });
    assert.equal(again.skipped, 2);
    assert.equal(again.ok, 0);
    assert.equal(store.listStageRun("SV", "SR1").length, 2); // not 4

    // a DIFFERENT run_id is an independent replicate (K=2)
    const r2 = await runStage({ store, stageVersion: "SV", stage: "gate", runId: "SR2", adapter: gateAdapter, timestamp: "T2" });
    assert.equal(r2.ok, 2);
    assert.deepEqual(store.listStageRunIds("SV").sort(), ["SR1", "SR2"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runStage: only replays fixtures of the requested stage", async () => {
  const { store, root } = tmpStore();
  try {
    store.putStageArtifact("SV", stageInstanceKey(blockFx), blockFx);
    // a detection fixture in the same corpus must be ignored by a gate run
    const det = { schema_version: "stage-artifacts/v1", item_id: "pr-block", stage: "detection", instance: { lens_id: "correctness" }, provenance: blockFx.provenance, input: {}, output: {} };
    store.putStageArtifact("SV", stageInstanceKey(det), det);
    const s = await runStage({ store, stageVersion: "SV", stage: "gate", runId: "SR1", adapter: gateAdapter, timestamp: "T0" });
    assert.equal(s.total, 1); // only the gate fixture
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveBlobRef: BlobRef → content; null ref → null", () => {
  const { store, root } = tmpStore();
  try {
    const ref = store.putStageBlob("SV", "the frozen diff");
    assert.equal(resolveBlobRef(store, "SV", ref), "the frozen diff");
    assert.equal(resolveBlobRef(store, "SV", null), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("STAGE_ADAPTERS registry exposes all three stages", () => {
  assert.equal(STAGE_ADAPTERS.gate, gateAdapter);
  assert.equal(STAGE_ADAPTERS.detection, detectionAdapter);
  assert.equal(STAGE_ADAPTERS.verifier, verifierAdapter);
  assert.deepEqual([STAGE_ADAPTERS.detection.stage_id, STAGE_ADAPTERS.verifier.stage_id, STAGE_ADAPTERS.gate.stage_id], ["detection", "verifier", "gate"]);
});

test("detectionAdapter.prepareInput: resolves frozen blobs → runLens inputs (free, no model)", () => {
  const { store, root } = tmpStore();
  try {
    const rubric = store.putStageBlob("SV", "RUBRIC");
    const diff = store.putStageBlob("SV", "DIFF");
    const issue = store.putStageBlob("SV", "ISSUE");
    const fx = {
      schema_version: "stage-artifacts/v1", item_id: "pr-1", stage: "detection",
      instance: { lens_id: "correctness" },
      provenance: { run_id: "R", config_hash: "sha256:c", sdk_version: "0.3.217", captured_at: "T", model: "claude-opus-5" },
      input: { rubric, diff, issue, changed_files: null, repo_commit: null, samples: 2, model: "claude-opus-5", title: "Correctness", needs_issue_spec: true },
      output: {},
    };
    const p = detectionAdapter.prepareInput(fx, { store, version: "SV", repoSource: null, repoCache: null });
    assert.equal(p.rubric, "RUBRIC");
    assert.equal(p.diff, "DIFF");
    assert.equal(p.issue, "ISSUE");
    assert.equal(p.samples, 2);
    assert.deepEqual(p.lens, { id: "correctness", title: "Correctness", model: "claude-opus-5", needsIssueSpec: true });
    assert.equal(typeof p.repo, "string"); // an (empty) working-tree dir for diff-only
    // a fixture with no issue blob → null issue
    const p2 = detectionAdapter.prepareInput({ ...fx, input: { ...fx.input, issue: null } }, { store, version: "SV" });
    assert.equal(p2.issue, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verifierAdapter.prepareInput: recomputes trust context from the frozen changed-files blob", () => {
  const { store, root } = tmpStore();
  try {
    const rubric = store.putStageBlob("SV", "RUBRIC");
    const changed_files = store.putStageBlob("SV", "a.ts\nb.ts\n");
    const finding = { severity: "major", confidence: "high", file: "a.ts", summary: "boom" };
    const fx = {
      schema_version: "stage-artifacts/v1", item_id: "pr-1", stage: "verifier",
      instance: { lens_id: "correctness", population: "fresh", finding_key: "a.ts::boom" },
      provenance: { run_id: "R", config_hash: "sha256:c", sdk_version: "0.3.217", captured_at: "T", model: "claude-opus-5" },
      input: { finding, rubric, changed_files, changed_context: { authoritative: true, total: 2, listed_count: 2 }, repo_commit: null, model: "claude-opus-5", max_turns: 8 },
      output: {},
    };
    const p = verifierAdapter.prepareInput(fx, { store, version: "SV", repoSource: null, repoCache: null });
    assert.deepEqual(p.finding, finding);
    assert.equal(p.rubric, "RUBRIC");
    assert.equal(p.model, "claude-opus-5");
    assert.equal(p.changedContext.authoritative, true); // 2 clean files → authoritative
    assert.equal(p.changedContext.total, 2);
    assert.equal(typeof p.repo, "string");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
