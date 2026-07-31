// signal-harvest — B1 of Track B. Turns a run's stage detail into the DRAFT
// finding-label population that B2 (human adjudication) resolves into silver/gold
// labels. Pure re-read of what an ordinary run already emits — never a re-run.
//
// A run payload carries `stageDetail[lens] = { samples, verifications }`:
//   - samples       — the raw findings each detection sample raised (samples:2 →
//                     two arrays); their deduped union is the finding set to LABEL.
//   - verifications  — one `{ population, finding, verdict, dropped }` per blocking
//                     finding the verifier saw; `dropped` is the panel's own
//                     keep/drop, i.e. its PREDICTION of is_real.
//
// Two things are harvested per unioned finding:
//   1. the finding itself (finding_key, lens, file, summary, severity, confidence,
//      sample agreement) — the labelling unit; and
//   2. a PREDICTION column = the panel's keep/drop. This is one NOISY signal, never
//      the label: grading the panel with its own output is circular (overview §4).
//      A label needs an INDEPENDENT signal (judge model / GitHub) to corroborate,
//      which is why mergeSignals() refuses to pre-fill is_real from the panel alone.
//
// The output is a draft-label set (`is_real: null` until adjudicated) with every
// finding's signals attached and its disagreements materialized — the B1 "done"
// state. It is NOT written into the gold/silver label store; it is a harvest
// artifact B2 reads. See ANNOTATION-GUIDE.md and track-b-validity-work-plan.md §B1.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { findingKey } from "./stage-artifacts.mjs";

const BLOCKING = new Set(["critical", "major"]); // mirrors severity.mjs: only these reach the verifier

/** The panel's keep/drop as an is_real GUESS (circular — a signal, not a label):
 *  kept (dropped=false) ⟹ panel believes real; dropped=true ⟹ panel believes fake.
 *  A finding that never reached the verifier has no keep/drop opinion → null. */
function panelPrediction(verifications) {
  if (!verifications || verifications.length === 0) return null; // never reached the verifier
  // A finding may be verified in both fresh and prior-round; "kept" iff some
  // population kept it (the gate sees a finding that survived any verification).
  const kept = verifications.some((v) => v.dropped === false);
  const dropped = verifications.every((v) => v.dropped === true);
  return {
    reached_verifier: true,
    kept,
    is_real_guess: kept ? true : dropped ? false : null,
    populations: verifications.map((v) => v.population),
    verdicts: verifications.map((v) => v.verdict ?? null),
  };
}

/**
 * Union the detection samples of ONE lens into distinct findings keyed by
 * findingKey, tracking how many samples raised each (the agreement signal), and
 * join the verifier's per-finding keep/drop prediction. Returns finding records.
 */
export function harvestLens(itemId, lensId, lensDetail) {
  const samples = Array.isArray(lensDetail?.samples) ? lensDetail.samples : [];
  const verifications = Array.isArray(lensDetail?.verifications) ? lensDetail.verifications : [];
  const sampleTotal = samples.length;

  // finding_key → { finding, raised } across samples (first occurrence wins for text).
  const union = new Map();
  for (const sample of samples) {
    const seenThisSample = new Set(); // a finding raised twice in one sample counts once
    for (const f of sample || []) {
      const key = findingKey(f);
      if (seenThisSample.has(key)) continue;
      seenThisSample.add(key);
      const cur = union.get(key);
      if (cur) cur.raised += 1;
      else union.set(key, { finding: f, raised: 1 });
    }
  }

  // finding_key → verifications for that finding.
  const vByKey = new Map();
  for (const v of verifications) {
    const key = findingKey(v.finding);
    if (!vByKey.has(key)) vByKey.set(key, []);
    vByKey.get(key).push(v);
  }

  const records = [];
  for (const [key, { finding, raised }] of union) {
    const severity = String(finding.severity ?? "").toLowerCase().trim();
    records.push({
      item_id: itemId,
      lens: lensId,
      finding_key: key,
      file: finding.file ?? null,
      summary: finding.summary ?? null,
      severity: severity || null,
      confidence: finding.confidence ?? null,
      blocking: BLOCKING.has(severity),
      samples: { raised, total: sampleTotal }, // 2/2 = both samples agreed; 1/2 = one-off
      prediction: panelPrediction(vByKey.get(key)),
    });
  }
  return records;
}

/** Harvest every lens in a run payload's stageDetail → the full finding population. */
export function harvestFindings(payload, itemId) {
  const sd = payload?.stageDetail;
  if (!sd || typeof sd !== "object") return [];
  const out = [];
  for (const lensId of Object.keys(sd)) out.push(...harvestLens(itemId, lensId, sd[lensId]));
  return out;
}

/**
 * Fold a finding record + optional INDEPENDENT signals into a draft finding label.
 * `judge` / `github` (when present) are `{ is_real: bool, evidence?, source? }` from
 * a different model family / GitHub mining — the un-anchored corroborators.
 *
 * Rule (overview §4): the panel prediction alone can NEVER set is_real (circular).
 *   - no independent signal            → is_real null, needs_adjudication (nothing to corroborate)
 *   - independent signals disagree     → is_real null, needs_adjudication (a real conflict)
 *   - independent agree, panel agrees  → pre-fill is_real, no adjudication (unanimous draft)
 *   - independent agree, panel differs → pre-fill is_real BUT flag needs_adjudication
 *                                        (the panel↔truth conflict is exactly what B2 checks)
 * Pre-filled drafts are label_source "silver" / confidence "low": a starting point,
 * not a settled label.
 */
export function mergeSignals(record, { judge, github } = {}) {
  const independent = [];
  if (judge && typeof judge.is_real === "boolean") independent.push({ source: "judge", ...judge });
  if (github && typeof github.is_real === "boolean") independent.push({ source: "github", ...github });

  const panelGuess = record.prediction?.is_real_guess ?? null;
  const signals = {
    panel: panelGuess == null ? null : { is_real: panelGuess, kept: record.prediction?.kept },
    ...(judge ? { judge } : {}),
    ...(github ? { github } : {}),
  };

  const base = {
    item_id: record.item_id,
    finding_key: record.finding_key,
    lens: record.lens,
    severity: record.severity,
    reached_verifier: record.prediction?.reached_verifier ?? false,
    signals,
  };

  if (independent.length === 0) {
    return { ...base, is_real: null, needs_adjudication: true, reason: "no independent signal — panel prediction alone cannot label (circular)" };
  }
  const votes = new Set(independent.map((s) => s.is_real));
  if (votes.size > 1) {
    return { ...base, is_real: null, needs_adjudication: true, reason: "independent signals disagree" };
  }
  const draft = independent[0].is_real; // unanimous among independents
  const panelDiffers = panelGuess != null && panelGuess !== draft;
  return {
    ...base,
    is_real: draft,
    label_source: "silver",
    confidence: "low",
    needs_adjudication: panelDiffers,
    reason: panelDiffers ? "independents agree but disagree with the panel keep/drop — confirm" : "independents agree with the panel — draft",
  };
}

/** Full item harvest → draft finding-label set. `signalsByKey` maps finding_key →
 * `{ judge?, github? }` (empty until the independent collectors are wired). */
export function harvestDraftLabels(payload, itemId, signalsByKey = {}) {
  return harvestFindings(payload, itemId).map((r) => mergeSignals(r, signalsByKey[r.finding_key] ?? {}));
}

// --- store-backed CLI -------------------------------------------------------

async function main() {
  const { GitFsStore } = await import("./store.mjs");
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (!process.argv[i].startsWith("--")) continue;
    const key = process.argv[i].slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith("--")) { args[key] = true; } // valueless flag (e.g. --emit)
    else { args[key] = next; i++; }
  }
  if (!args.out || !args.run) {
    console.error("usage: signal-harvest.mjs --out <repo> --run <run_id> [--item <item_id>] [--emit]");
    process.exit(2);
  }
  const store = new GitFsStore(args.out);
  const items = args.item ? [args.item] : store.listItems(args.run);
  if (items.length === 0) { console.error(`no items under run ${args.run}`); process.exit(1); }

  let population = 0, blocking = 0, pending = 0;
  const perItem = [];
  for (const itemId of items) {
    const { payload } = store.getItem(args.run, itemId);
    const drafts = harvestDraftLabels(payload, itemId);
    const b = drafts.filter((d) => d.reached_verifier).length;
    population += drafts.length; blocking += b;
    pending += drafts.filter((d) => d.needs_adjudication).length;
    perItem.push({ item_id: itemId, findings: drafts.length, blocking: b, drafts });
    console.error(`${itemId}: ${drafts.length} findings (${b} reached verifier / V1 population), ${drafts.filter((d) => d.needs_adjudication).length} need adjudication`);
  }
  console.error(`\nharvest: ${population} findings across ${items.length} item(s), ${blocking} reached the verifier, ${pending} awaiting adjudication (0 independent signals wired yet)`);
  if (args.emit) console.log(JSON.stringify(perItem, null, 2)); // stdout = the draft harvest artifact
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("signal-harvest failed:", e); process.exit(1); });
}
