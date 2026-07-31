import { test } from "node:test";
import assert from "node:assert/strict";
import { findingKey } from "./stage-artifacts.mjs";
import {
  harvestLens, harvestFindings, mergeSignals, harvestDraftLabels,
} from "./signal-harvest.mjs";

// A raw lens finding; findingKey = `${file}::${lowercased summary}`.
const f = (over = {}) => ({
  severity: over.severity ?? "critical",
  confidence: over.confidence ?? "medium",
  summary: over.summary ?? "a bug",
  file: over.file ?? "a.ts",
  ...over,
});
const ver = (finding, dropped, population = "fresh", verdict = null) => ({ population, finding, verdict, dropped });

test("harvestLens: unions samples by finding_key and counts agreement", () => {
  const shared = f({ summary: "shared bug", file: "x.ts" });
  const oneOff = f({ summary: "one-off", file: "y.ts" });
  const lensDetail = {
    samples: [[shared, oneOff], [f({ summary: "shared bug", file: "x.ts" })]], // shared in both, one-off in one
    verifications: [],
  };
  const recs = harvestLens("pr-1", "correctness", lensDetail);
  assert.equal(recs.length, 2); // deduped to 2 distinct findings
  const bySummary = Object.fromEntries(recs.map((r) => [r.summary, r]));
  assert.deepEqual(bySummary["shared bug"].samples, { raised: 2, total: 2 }); // both samples
  assert.deepEqual(bySummary["one-off"].samples, { raised: 1, total: 2 });    // one sample
});

test("harvestLens: a finding raised twice in ONE sample counts once for that sample", () => {
  const dup = f({ summary: "dup", file: "x.ts" });
  const recs = harvestLens("pr-1", "correctness", { samples: [[dup, dup]], verifications: [] });
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].samples, { raised: 1, total: 1 });
});

test("harvestLens: joins the verifier keep/drop prediction and marks blocking", () => {
  const kept = f({ summary: "real one", file: "x.ts", severity: "critical" });
  const droppedF = f({ summary: "fake one", file: "y.ts", severity: "major" });
  const minorF = f({ summary: "nit one", file: "z.ts", severity: "minor" });
  const lensDetail = {
    samples: [[kept, droppedF, minorF]],
    verifications: [ver(kept, false), ver(droppedF, true)], // minor never reached the verifier
  };
  const recs = harvestLens("pr-1", "correctness", lensDetail);
  const by = Object.fromEntries(recs.map((r) => [r.summary, r]));
  assert.equal(by["real one"].blocking, true);
  assert.equal(by["real one"].prediction.reached_verifier, true);
  assert.equal(by["real one"].prediction.kept, true);
  assert.equal(by["real one"].prediction.is_real_guess, true);   // kept ⟹ panel thinks real
  assert.equal(by["fake one"].prediction.is_real_guess, false);  // dropped ⟹ panel thinks fake
  assert.equal(by["nit one"].blocking, false);
  assert.equal(by["nit one"].prediction, null);                  // never reached the verifier
});

test("harvestLens: kept iff SOME population kept it (fresh drop + prior-round keep ⟹ kept)", () => {
  const g = f({ summary: "flip", file: "x.ts" });
  const recs = harvestLens("pr-1", "correctness", {
    samples: [[g]],
    verifications: [ver(g, true, "fresh"), ver(g, false, "prior-round")],
  });
  assert.equal(recs[0].prediction.kept, true);
  assert.equal(recs[0].prediction.is_real_guess, true);
  assert.deepEqual(recs[0].prediction.populations, ["fresh", "prior-round"]);
});

test("harvestFindings: walks every lens in stageDetail; empty/absent → []", () => {
  const payload = {
    stageDetail: {
      correctness: { samples: [[f({ summary: "c", file: "a.ts" })]], verifications: [] },
      security: { samples: [[f({ summary: "s", file: "b.ts" })]], verifications: [] },
    },
  };
  assert.equal(harvestFindings(payload, "pr-1").length, 2);
  assert.deepEqual(harvestFindings({}, "pr-1"), []);
  assert.deepEqual(harvestFindings({ stageDetail: null }, "pr-1"), []);
});

// --- mergeSignals: the circularity guard ------------------------------------

const rec = (over = {}) => ({
  item_id: "pr-1", finding_key: "a.ts::bug", lens: "correctness", severity: "critical",
  prediction: over.prediction === undefined ? { reached_verifier: true, kept: true, is_real_guess: true } : over.prediction,
});

test("mergeSignals: panel prediction ALONE never labels — always needs adjudication", () => {
  const d = mergeSignals(rec(), {}); // no independent signal
  assert.equal(d.is_real, null);
  assert.equal(d.needs_adjudication, true);
  assert.match(d.reason, /circular|no independent/);
  assert.ok(d.signals.panel); // the panel signal is still recorded, just not authoritative
});

test("mergeSignals: independents disagree → null, needs adjudication", () => {
  const d = mergeSignals(rec(), { judge: { is_real: true }, github: { is_real: false } });
  assert.equal(d.is_real, null);
  assert.equal(d.needs_adjudication, true);
  assert.match(d.reason, /disagree/);
});

test("mergeSignals: independents agree WITH the panel → pre-filled draft, no adjudication", () => {
  const d = mergeSignals(rec({ prediction: { reached_verifier: true, kept: true, is_real_guess: true } }),
    { judge: { is_real: true } });
  assert.equal(d.is_real, true);
  assert.equal(d.needs_adjudication, false);
  assert.equal(d.label_source, "silver");
  assert.equal(d.confidence, "low");
});

test("mergeSignals: independents agree but CONTRADICT the panel → draft set, but flagged", () => {
  // Panel dropped it (guess fake); the independent judge says real → the interesting case.
  const d = mergeSignals(rec({ prediction: { reached_verifier: true, kept: false, is_real_guess: false } }),
    { judge: { is_real: true } });
  assert.equal(d.is_real, true);            // trust the independent signal for the draft
  assert.equal(d.needs_adjudication, true); // but a panel↔truth conflict is exactly what B2 checks
  assert.match(d.reason, /disagree with the panel/);
});

test("mergeSignals: a finding that never reached the verifier has a null panel signal", () => {
  const d = mergeSignals(rec({ prediction: null }), { judge: { is_real: false } });
  assert.equal(d.signals.panel, null);
  assert.equal(d.reached_verifier, false);
  assert.equal(d.is_real, false);
});

test("harvestDraftLabels: joins per-finding signals by finding_key end-to-end", () => {
  const real = f({ summary: "real", file: "x.ts" });
  const payload = { stageDetail: { correctness: { samples: [[real]], verifications: [ver(real, false)] } } };
  const key = findingKey(real);
  const drafts = harvestDraftLabels(payload, "pr-1", { [key]: { judge: { is_real: true } } });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].finding_key, key);
  assert.equal(drafts[0].is_real, true);
  assert.equal(drafts[0].needs_adjudication, false); // judge agrees with the panel keep
});
