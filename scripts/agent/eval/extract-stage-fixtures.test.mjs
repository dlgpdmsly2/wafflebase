import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitFsStore } from "./store.mjs";
import { extractItemFixtures, itemContext, defaultStageVersion } from "./extract-stage-fixtures.mjs";
import { validateStageArtifact, stageInstanceKey } from "./stage-artifacts.mjs";

function tmpStore() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-eval-stagefix-"));
  return { store: new GitFsStore(root), root };
}

const runJson = { run_id: "R1", config_hash: "sha256:cfg", corpus_version: "CV", sdk_version: "0.3.217" };
const snapshot = {
  config_hash: "sha256:cfg",
  lenses: [
    { id: "correctness", title: "Correctness", model: "claude-opus-5", samples: 2, rubric_text: "RUB" },
    { id: "security", title: "Security", model: "claude-opus-5", samples: 2, rubric_text: "RUB" }, // same rubric → blob dedup
  ],
};
const boom = { severity: "major", confidence: "high", file: "a.ts", summary: "boom", evidence: "e" };
const payload = () => ({
  panel: [
    { id: "correctness", title: "Correctness", blocking: true, applicable: true, conclusion: "failure", valid: true },
    { id: "security", title: "Security", blocking: true, applicable: true, conclusion: "success", valid: true },
  ],
  findings: [{ lens: "correctness", severity: "major", file: "a.ts", summary: "boom", evidence: "e" }],
  stageDetail: {
    correctness: {
      samples: [[boom], [{ severity: "major", confidence: "high", file: "a.ts", summary: "boom" }]],
      verifications: [{ population: "fresh", finding: boom, verdict: { verdict: "confirmed", confidence: "low", reason: "x", refutationGround: "none", groundedIn: [] }, dropped: false }],
    },
    security: { samples: [[], []], verifications: [] },
  },
});

function seed(store) {
  store.putCorpusItem("pr-1", { meta: { id: "pr-1", review_commit: "abc" }, diff: "DIFF", changedFiles: ["a.ts", "c.ts"], issueSpec: "" });
}

test("extractItemFixtures: harvests det×2 + ver×1 + gate×1, all valid, blobs stored+deduped", () => {
  const { store, root } = tmpStore();
  try {
    seed(store);
    const corpusInput = store.getCorpusItemInput("pr-1");
    const envelope = { item_id: "pr-1", status: "ok", timestamp: "2026-07-29T00:00:00.000Z" };
    const r = extractItemFixtures({ store, version: "SV", runJson, snapshot, corpusInput, envelope, payload: payload() });

    assert.deepEqual(r.byStage, { detection: 2, verifier: 1, gate: 1 });
    assert.equal(r.count, 4);

    const stored = store.listStageArtifacts("SV");
    assert.equal(stored.length, 4);
    for (const a of stored) assert.deepEqual(validateStageArtifact(a), { valid: true, errors: [] });

    // provenance stamped from the run/envelope, not the panel
    const det = stored.find((a) => a.stage === "detection" && a.instance.lens_id === "correctness");
    assert.equal(det.provenance.run_id, "R1");
    assert.equal(det.provenance.config_hash, "sha256:cfg");
    assert.equal(det.provenance.captured_at, "2026-07-29T00:00:00.000Z");
    assert.equal(det.input.repo_commit, "abc");

    // the diff BlobRef resolves to the frozen diff content
    assert.equal(store.getStageBlob("SV", det.input.diff.sha256), "DIFF");
    // both lenses share one rubric blob (dedup): same sha for both detection artifacts
    const secDet = stored.find((a) => a.stage === "detection" && a.instance.lens_id === "security");
    assert.equal(det.input.rubric.sha256, secDet.input.rubric.sha256);

    // addressable by key
    const gate = stored.find((a) => a.stage === "gate");
    assert.deepEqual(store.getStageArtifact("SV", stageInstanceKey(gate)), gate);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("extractItemFixtures: re-extraction is idempotent (write-once keys)", () => {
  const { store, root } = tmpStore();
  try {
    seed(store);
    const corpusInput = store.getCorpusItemInput("pr-1");
    const envelope = { item_id: "pr-1", status: "ok", timestamp: "2026-07-29T00:00:00.000Z" };
    extractItemFixtures({ store, version: "SV", runJson, snapshot, corpusInput, envelope, payload: payload() });
    extractItemFixtures({ store, version: "SV", runJson, snapshot, corpusInput, envelope, payload: payload() });
    assert.equal(store.listStageArtifacts("SV").length, 4); // not 8
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("extractItemFixtures: non-ok items are skipped (contaminated verdict)", () => {
  const { store, root } = tmpStore();
  try {
    seed(store);
    const corpusInput = store.getCorpusItemInput("pr-1");
    const r = extractItemFixtures({ store, version: "SV", runJson, snapshot, corpusInput, envelope: { item_id: "pr-1", status: "error" }, payload: payload() });
    assert.equal(r.skipped, true);
    assert.equal(store.listStageArtifacts("SV").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("itemContext: builds refs + provenance; defaultStageVersion groups by corpus+config", () => {
  const { store, root } = tmpStore();
  try {
    seed(store);
    const corpusInput = store.getCorpusItemInput("pr-1");
    const ctx = itemContext({ store, version: "SV", runJson, snapshot, corpusInput, envelope: { item_id: "pr-1", status: "ok", timestamp: "T" } });
    assert.equal(ctx.item_id, "pr-1");
    assert.equal(ctx.repo_commit, "abc");
    assert.deepEqual(Object.keys(ctx.refs.rubricByLens).sort(), ["correctness", "security"]);
    assert.equal(ctx.lensMeta.correctness.samples, 2);
    assert.equal(ctx.refs.issue, null); // empty issueSpec → no ref
    assert.equal(defaultStageVersion(runJson), "CV__cfg");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
