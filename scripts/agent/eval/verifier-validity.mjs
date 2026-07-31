// verifier-validity — V1 of Track B. The verifier stage's VALIDITY (is it right?),
// the counterpart to stage-reliability's verifier consistency (is it stable?).
//
// The verifier is a per-finding binary classifier: keep the real defects, drop the
// hallucinations. Joining each verifier artifact (output.dropped) to its finding
// label (is_real) yields a confusion matrix:
//
//                 verifier KEEPS        verifier DROPS
//   real defect   keep_real (good)      drop_real  (killed a real bug — the #521 cell)
//   hallucination keep_fake (junk→gate) drop_fake  (good)
//
// The verdict reads on two orthogonal, base-rate-independent axes: keep_recall (did
// it preserve real defects — the HARM axis) and drop_specificity (did it drop the
// junk it saw — the VALUE axis). precision_lift (kept-set vs input-set precision,
// overview §2.3) is a base-rate-confounded summary, used only as a sign check —
// judging on it alone lets a rubber stamp read "effective". Sliced by
// instance.population (fresh vs prior-round) — the #521 axis.
//
// Truth needs the finding-level labels (store.getFindingLabel). Errored/unlabeled
// verifier decisions are EXCLUDED, never laundered into the matrix (same discipline
// as stage-reliability: an infra failure is not a judgement).
//
// Pure core (verifierDecision / computeVerifierValidity) is exported and unit-tested;
// the store-backed CLI is a thin wrapper.

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The keep/drop decision a verifier artifact recorded, or null to EXCLUDE it:
 *   - not a verifier artifact                          → null
 *   - the verifier errored (output.error set)          → null (no classification made;
 *       operationally the finding is kept, but that is an infra effect, not a judgement)
 *   - output.dropped missing/non-boolean               → null
 *   - otherwise → "drop" (dropped=true) | "keep" (dropped=false)
 */
export function verifierDecision(art) {
  if (!art || art.stage !== "verifier" || typeof art.output !== "object" || art.output === null) return null;
  const out = art.output;
  if (out.error != null) return null;
  if (typeof out.dropped !== "boolean") return null;
  return out.dropped ? "drop" : "keep";
}

/** Which confusion cell a (decision, is_real) pair falls in, or null if either is unset. */
export function confusionCell(decision, isReal) {
  if (typeof isReal !== "boolean" || (decision !== "keep" && decision !== "drop")) return null;
  if (decision === "keep") return isReal ? "keep_real" : "keep_fake";
  return isReal ? "drop_real" : "drop_fake";
}

const ratio = (num, den) => (den === 0 ? null : num / den); // null (not 0) = no data, per stage-reliability

/** Derived metrics from a {keep_real,keep_fake,drop_real,drop_fake} matrix. Positive
 * class = a real defect the verifier should keep. All ratios null when undefined. */
export function metricsFromMatrix(m) {
  const { keep_real, keep_fake, drop_real, drop_fake } = m;
  const kept = keep_real + keep_fake;
  const reached_real = keep_real + drop_real;
  const reached_fake = keep_fake + drop_fake;
  const total = kept + drop_real + drop_fake;
  const kept_precision = ratio(keep_real, kept);          // of what it KEPT, fraction real
  const keep_recall = ratio(keep_real, reached_real);     // of real defects it saw, fraction kept
  const input_precision = ratio(reached_real, total);     // precision of findings REACHING the verifier
  return {
    n: total,
    kept_precision,
    keep_recall,                                          // = recall_retained through the verifier
    drop_specificity: ratio(drop_fake, reached_fake),     // of hallucinations it saw, fraction dropped
    input_precision,
    output_precision: kept_precision,
    // the §2.3 bracket: how much cleaner the KEPT set is than the INPUT set
    precision_lift: kept_precision != null && input_precision != null ? kept_precision - input_precision : null,
  };
}

// Verdict thresholds — POLICY knobs, deliberate not tuned-to-data. A reviewer may
// tighten these; they are named so the choice is visible, not buried in comparisons.
const RECALL_SAFE = 0.8;   // keep_recall ≥ this ⟹ the verifier preserved (nearly) all real defects it saw
const RECALL_HARM = 0.5;   // keep_recall < this ⟹ it killed most real defects → harmful regardless of precision
const SPEC_CLEANS = 0.5;   // drop_specificity ≥ this ⟹ it drops the MAJORITY of junk it saw (earns its keep)

/**
 * Qualitative read on TWO orthogonal, base-rate-independent axes — not on
 * precision_lift alone, which moves with the input base rate and so rewards a
 * rubber stamp when junk happens to be plentiful:
 *   - harm axis   = keep_recall      (did it preserve the real defects it saw?)
 *   - value axis  = drop_specificity (did it drop the hallucinations it saw?)
 * precision_lift is used only as a sign check (a verifier facing junk that fails
 * to clean the set is useless). Verdicts:
 *   no-data | insufficient | net-harmful | mixed | rubber-stamp | effective
 * `rubber-stamp` (safe recall but sub-majority specificity) is the #521 box: it
 * keeps the real defects yet waves most junk through — weak, not "effective".
 */
export function effectiveness(m) {
  if (m.n === 0) return "no-data";

  // Harm axis first — killing most real defects it saw is harmful no matter how
  // clean the kept set looks. Checked before the precision_lift null-guard so a
  // verifier that kept nothing can still be damned by its recall.
  if (m.keep_recall != null && m.keep_recall < RECALL_HARM) return "net-harmful";
  const recallSafe = m.keep_recall == null || m.keep_recall >= RECALL_SAFE;
  const recallSoft = m.keep_recall != null && m.keep_recall >= RECALL_HARM && m.keep_recall < RECALL_SAFE;

  // Kept nothing / nothing reached it, and recall isn't damning → nothing to judge.
  if (m.precision_lift == null) return "insufficient";

  // Value axis — of the hallucinations it saw, did it drop them? null = none
  // reached it (it was never tested on junk); ≥ floor = cleans; below = rubber stamp.
  const spec = m.drop_specificity;
  const noJunkSeen = spec == null;
  const cleansJunk = spec != null && spec >= SPEC_CLEANS;

  // Junk DID reach it but the kept set is no cleaner (or dirtier) than the input → useless.
  if (!noJunkSeen && m.precision_lift <= 0) return "net-harmful";

  if (recallSoft) return "mixed";          // safe-ish, but still killed some real defects

  // recallSafe from here on.
  if (noJunkSeen) return "insufficient";   // kept the reals, but never faced a hallucination to drop
  if (cleansJunk) return "effective";      // keeps the reals AND drops the majority of junk it saw
  return "rubber-stamp";                    // keeps the reals but waves most junk through (the #521 shape)
}

function tally(records) {
  const matrix = { keep_real: 0, keep_fake: 0, drop_real: 0, drop_fake: 0 };
  const real_drops = []; // the damage list — real defects the verifier killed (#521)
  for (const r of records) {
    const cell = confusionCell(r.decision, r.is_real);
    if (!cell) continue;
    matrix[cell]++;
    if (cell === "drop_real") real_drops.push({ item_id: r.item_id, finding_key: r.finding_key, population: r.population });
  }
  const metrics = metricsFromMatrix(matrix);
  return { matrix, metrics, effectiveness: effectiveness(metrics), real_drops };
}

/**
 * Verifier-stage validity over pre-joined records. Each record:
 *   { item_id, finding_key, population, decision: "keep"|"drop"|null, is_real: bool|null }
 * Records with a null decision (errored/excluded) or null is_real (unlabeled) are
 * counted under `excluded` and left out of every matrix. Returns overall + a slice
 * per population (fresh / prior-round).
 */
export function computeVerifierValidity(records) {
  const list = records || [];
  const scorable = list.filter((r) => confusionCell(r.decision, r.is_real) !== null);
  const excluded = {
    errored: list.filter((r) => r.decision == null).length,
    unlabeled: list.filter((r) => r.decision != null && typeof r.is_real !== "boolean").length,
  };
  const by_population = {};
  for (const pop of ["fresh", "prior-round"]) {
    by_population[pop] = tally(scorable.filter((r) => r.population === pop));
  }
  return { overall: tally(scorable), by_population, excluded, n_scored: scorable.length };
}

/**
 * Join verifier artifacts to finding labels via the store. `artifacts` = verifier
 * stage artifacts (instance.finding_key addresses the label). Returns the record
 * list computeVerifierValidity consumes.
 */
export function joinVerifierRecords(store, corpusVersion, artifacts) {
  return (artifacts || [])
    .filter((a) => a && a.stage === "verifier")
    .map((a) => {
      const label = store.getFindingLabel(corpusVersion, a.item_id, a.instance?.finding_key);
      return {
        item_id: a.item_id,
        finding_key: a.instance?.finding_key,
        population: a.instance?.population,
        decision: verifierDecision(a),
        is_real: label && typeof label.is_real === "boolean" ? label.is_real : null,
      };
    });
}

// --- store-backed CLI -------------------------------------------------------

async function main() {
  const { GitFsStore } = await import("./store.mjs");
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  if (!args.out || !args["stage-version"] || !args["corpus-version"]) {
    console.error("usage: verifier-validity.mjs --out <repo> --stage-version <v> --corpus-version <cv> [--scorer-id]");
    process.exit(2);
  }
  const store = new GitFsStore(args.out);
  const version = args["stage-version"];
  const corpusVersion = args["corpus-version"];
  const scorerId = args["scorer-id"] ?? "verifier-validity";

  const artifacts = store.listStageArtifacts(version).filter((a) => a && a.stage === "verifier");
  if (artifacts.length === 0) { console.error(`no verifier artifacts under stage-version ${version}`); process.exit(1); }

  const records = joinVerifierRecords(store, corpusVersion, artifacts);
  const result = computeVerifierValidity(records);
  const scoreJson = {
    scorer_id: scorerId, scorer_version: "verifier-validity-v1", stage: "verifier",
    computed: new Date().toISOString(), stage_version: version, corpus_version: corpusVersion,
    ...result,
  };
  store.putStageScore(version, scorerId, scoreJson);
  const o = result.overall;
  const pl = o.metrics.precision_lift;
  console.log(
    `verifier-validity: n=${result.n_scored} ` +
    `[keep_real=${o.matrix.keep_real} keep_fake=${o.matrix.keep_fake} ` +
    `drop_real=${o.matrix.drop_real} drop_fake=${o.matrix.drop_fake}] ` +
    `kept_precision=${o.metrics.kept_precision?.toFixed(3) ?? "n/a"} ` +
    `precision_lift=${pl != null ? pl.toFixed(3) : "n/a"} ` +
    `keep_recall=${o.metrics.keep_recall?.toFixed(3) ?? "n/a"} → ${o.effectiveness} ` +
    `(excluded: ${result.excluded.errored} errored, ${result.excluded.unlabeled} unlabeled)`
  );
  if (o.real_drops.length) console.log(`  real defects DROPPED (${o.real_drops.length}):`, o.real_drops.map((d) => `${d.item_id}/${d.population}`).join(", "));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("verifier-validity failed:", e); process.exit(1); });
}
