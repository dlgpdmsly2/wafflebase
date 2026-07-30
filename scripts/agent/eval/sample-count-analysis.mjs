// sample-count-analysis — is the review panel's SECOND detection sample earning
// its cost? Offline, model-free analysis over replicate single-sample draws.
//
// The panel runs each lens `samples: N` times and ORs the results, a mitigation
// for run-to-run non-determinism that doubles the largest single line item in
// review cost. This module answers whether N=1 loses anything, by measuring what
// an N-sample union would have caught given a pool of independent draws.
//
// UNIT OF ANALYSIS: one (item, lens) pair. Each `stage-detail.json` /
// detection-stage replay contributes its `per_sample` arrays as independent
// single-sample DRAWS, so R replicates at `samples: 2` yield D = 2R draws. Sample
// count is resampled from that pool rather than re-run at each N.
//
// MATCHER: `findingSimilarity` (rounds.mjs) — the deterministic overlap-coefficient
// matcher, gated on same lens + same file, calibrated on real panel output to
// separate one-defect-reworded from distinct-defects. Deliberately NOT
// `compareSampleAgreement` (review-panel.mjs) nor `decisionForStage`
// (stage-reliability.mjs): both key on `file::lowercased-summary`, an EXACT string,
// so two draws that find the same defect in different words read as disjoint. Every
// metric here would be biased by that — a reworded restatement would look like a
// finding the second sample uniquely caught, inflating the very number we are
// trying to measure. Also not `clusterFindings`: it returns merged survivors and
// discards WHICH draws each defect came from, and that membership set is the whole
// basis of the curve below.
//
// EXACT, NOT MONTE CARLO. "Average over many random N-subsets" is the obvious
// implementation and an unnecessary one. For a defect appearing in m of D draws,
// the probability that a uniformly random N-subset (without replacement) contains
// at least one of them is a closed form — 1 − C(D−m,N)/C(D,N) — so the whole curve
// is computed exactly. No RNG, no seed to thread, no sampling noise, and the tests
// can assert equality against hand-computed fractions.
//
// SCOPE (deliberate, per the run's framing): detection output only. No verifier,
// no lane, no panel gate. `blocking` here means severity critical/major and nothing
// else. The verdict-level metric is therefore a per-lens PROXY (§ proxy_* below),
// not the panel's block/approve decision.
//
// The corpus is unlabeled, so recall is measured against a SELF-CONSISTENCY ORACLE:
// the semantic union of all D draws. It reports coverage relative to what the panel
// can find across repeated tries, not against ground truth.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { findingSimilarity, DEFAULT_SIMILARITY } from "../rounds.mjs";
import { BLOCKING, KNOWN, normalizeSeverity } from "../severity.mjs";

/** Most-severe-wins rank: 0 = critical … 3 = nit. */
const rank = (sev) => KNOWN.indexOf(normalizeSeverity(sev));

/**
 * C(D−m, N) / C(D, N) — the probability that a uniformly random N-subset of D
 * draws contains NONE of the m draws carrying some defect. Computed as a running
 * product of (D−m−i)/(D−i) rather than via factorials, so it neither overflows nor
 * loses precision at the sizes involved.
 *
 * m = 0 (a defect in no draw) → 1: it can never be hit. N > D−m → 0: too few
 * defect-free draws remain to fill the subset, so a hit is certain.
 */
export function missRatio(D, m, N) {
  if (m <= 0) return 1;
  if (N <= 0) return 1;
  if (N > D - m) return 0;
  let r = 1;
  for (let i = 0; i < N; i++) r *= (D - m - i) / (D - i);
  return r;
}

/** Probability a random N-subset of D draws contains ≥1 of the m marked draws. */
export const hitProbability = (D, m, N) => 1 - missRatio(D, m, N);

/**
 * Group the findings of D draws into distinct defects by semantic similarity,
 * recording WHICH draws each defect appeared in.
 *
 * `draws` is an array of finding arrays — element i is what draw i reported.
 * `lens` is stamped onto every finding before matching: `findingSimilarity` gates
 * on lens equality, and the branch's `normalizeFindings` rebuilds findings as
 * exactly `{severity,file,summary,evidence}`, dropping any lens tag the panel had
 * attached. Without the stamp every pair would score 0 and every wording would
 * count as its own defect.
 *
 * Grouping is by CONNECTED COMPONENT, not first-match: if A~B and B~C, all three
 * are one defect even when A and C fall below the threshold on their own. The
 * panel restates one defect at different levels of detail, so the chain through an
 * intermediate wording is the common case rather than an edge case.
 */
export function clusterDraws(draws, { lens, threshold = DEFAULT_SIMILARITY } = {}) {
  const items = [];
  (Array.isArray(draws) ? draws : []).forEach((findings, drawIndex) => {
    for (const f of Array.isArray(findings) ? findings : []) {
      items.push({ drawIndex, finding: { ...f, lens, severity: normalizeSeverity(f?.severity) } });
    }
  });

  // Union-find over the similarity graph.
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (findingSimilarity(items[i].finding, items[j].finding) >= threshold) union(i, j);
    }
  }

  const byRoot = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(it);
  });

  const clusters = [...byRoot.values()].map((members) => {
    // Representative = the most severe member; ties broken by the longest wording
    // (the most specific statement of the defect), then lexically so the choice is
    // deterministic across runs.
    const rep = [...members].sort((a, b) =>
      rank(a.finding.severity) - rank(b.finding.severity) ||
      String(b.finding.summary ?? "").length - String(a.finding.summary ?? "").length ||
      String(a.finding.summary ?? "").localeCompare(String(b.finding.summary ?? ""))
    )[0].finding;

    const drawsIn = [...new Set(members.map((m) => m.drawIndex))].sort((a, b) => a - b);
    // Draws where this defect was reported AT blocking severity — a defect can be
    // called `major` by one draw and `minor` by another, and the per-subset verdict
    // must follow what that subset actually said, not the cluster's maximum.
    const blockingDraws = [...new Set(
      members.filter((m) => BLOCKING.has(m.finding.severity)).map((m) => m.drawIndex),
    )].sort((a, b) => a - b);

    return {
      lens, file: rep.file ?? null, summary: rep.summary ?? null,
      severity: rep.severity,                       // the max across members
      blocking: BLOCKING.has(rep.severity),
      draws: drawsIn, n_draws: drawsIn.length,
      blocking_draws: blockingDraws,
      n_findings: members.length,
      wordings: [...new Set(members.map((m) => String(m.finding.summary ?? "")))],
    };
  });

  // Stable order: most-reproduced defects first, then most severe.
  return clusters.sort((a, b) => b.n_draws - a.n_draws || rank(a.severity) - rank(b.severity) ||
    String(a.summary ?? "").localeCompare(String(b.summary ?? "")));
}

/**
 * The sample-count curve for one (item, lens) pair.
 *
 * `blocking_recall(N)` — expected fraction of the oracle's BLOCKING defects that an
 * N-sample union would surface. A defect counts as recalled when any draw carrying
 * it lands in the subset (it was detected); severity attaches to the defect via the
 * cluster maximum, matching the panel's own most-severe-wins merge.
 *
 * `block_rate(N)` — probability the lens raises ≥1 blocking finding at N samples.
 * Note this needs no inclusion–exclusion over clusters: a subset contains a blocking
 * finding iff it contains a draw that itself reported one, so the whole event
 * collapses to a single hypergeometric hit against the set of blocking draws.
 *
 * `flip_rate(N)` — how often the lens disagrees with its own modal decision at that
 * N, i.e. min(p, 1−p). 0 = the lens always lands the same way; 0.5 = a coin flip.
 */
export function curveForDraws(clusters, D) {
  const oracleBlocking = clusters.filter((c) => c.blocking);
  // Draws that reported at least one blocking finding, via cluster membership.
  const blockingDrawSet = new Set(oracleBlocking.flatMap((c) => c.blocking_draws));
  const B = blockingDrawSet.size;

  const curve = [];
  for (let N = 1; N <= D; N++) {
    const recall = oracleBlocking.length
      ? oracleBlocking.reduce((s, c) => s + hitProbability(D, c.n_draws, N), 0) / oracleBlocking.length
      : null;
    const blockRate = hitProbability(D, B, N);
    curve.push({
      n: N,
      blocking_recall: recall,
      block_rate: blockRate,
      proxy_verdict: blockRate >= 0.5 ? "block" : "approve",
      proxy_flip_rate: Math.min(blockRate, 1 - blockRate),
    });
  }
  return curve;
}

/**
 * Smallest N after which blocking recall stops rising materially — context for
 * whether even N=2 is the right operating point. null when the curve never settles
 * within the available draws (or there is nothing to recall).
 *
 * READ WITH CARE. The oracle is the union of all D draws, so recall(D) = 1 BY
 * CONSTRUCTION and the curve is pinned to 1 at its right end no matter how noisy
 * the panel is. The rise near N=D is therefore partly an artefact of the oracle
 * rather than evidence of real headroom, and a null flatten point means "still
 * climbing at D", not "N=D is required". Only the low-N end — and above all
 * `marginal_second_sample` — bears on the 2-vs-1 decision. More draws (larger D)
 * push the artefact further right; they never remove it.
 */
export function flattenPoint(curve, { epsilon = 0.01 } = {}) {
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i].blocking_recall, b = curve[i + 1].blocking_recall;
    if (a == null || b == null) return null;
    if (b - a < epsilon) return curve[i].n;
  }
  return null;
}

/**
 * Analyze one (item, lens) group. `draws` = array of per-draw finding arrays.
 */
export function analyzeGroup({ item_id, lens_id, draws }, opts = {}) {
  const D = (Array.isArray(draws) ? draws : []).length;
  const clusters = clusterDraws(draws, { lens: lens_id, threshold: opts.threshold });
  const curve = curveForDraws(clusters, D);
  const blocking = clusters.filter((c) => c.blocking);
  const at = (n) => curve.find((p) => p.n === n) ?? null;
  const B = new Set(blocking.flatMap((c) => c.blocking_draws)).size;

  return {
    item_id, lens_id, n_draws: D,
    n_defects: clusters.length,
    n_blocking_defects: blocking.length,
    blocking_draws: B,
    // A group where every draw blocks, or none does, carries no stability signal —
    // reporting it as "stable" alongside genuinely contested groups would let
    // emptiness masquerade as agreement (the trap stage-reliability.mjs calls out).
    contested: B > 0 && B < D,
    // Blocking defects only ONE draw ever found: precisely what a single sample
    // risks losing, and the most direct read on the question.
    singleton_blocking: blocking.filter((c) => c.n_draws === 1)
      .map((c) => ({ file: c.file, summary: c.summary, severity: c.severity, draw: c.draws[0] })),
    curve,
    marginal_second_sample: (at(1)?.blocking_recall == null || at(2)?.blocking_recall == null)
      ? null : at(2).blocking_recall - at(1).blocking_recall,
    flatten_point: flattenPoint(curve, opts),
  };
}

/**
 * Aggregate across groups. Recall is MICRO-averaged — pooled over every blocking
 * defect in the corpus, each weighted equally — because the decision is about how
 * many real findings get lost, and a lens that found ten defects should not be
 * outvoted by one that found a single defect. Flip rate is macro-averaged over
 * groups, since there the unit of instability IS the lens decision.
 *
 * A group only contributes at N ≤ its own draw count; `n_groups` / `n_defects` are
 * reported per N so a curve that thins out at high N cannot be read as if it were
 * measured on the full corpus.
 */
export function computeSampleCount(groups, opts = {}) {
  const per_group = (groups || []).map((g) => analyzeGroup(g, opts));
  const maxD = per_group.reduce((m, g) => Math.max(m, g.n_draws), 0);

  const curve = [];
  for (let N = 1; N <= maxD; N++) {
    const eligible = per_group.filter((g) => g.n_draws >= N);
    const withBlocking = eligible.filter((g) => g.n_blocking_defects > 0);
    const defects = withBlocking.reduce((s, g) => s + g.n_blocking_defects, 0);
    const recall = defects
      ? withBlocking.reduce((s, g) => {
          const p = g.curve.find((c) => c.n === N);
          return s + (p?.blocking_recall ?? 0) * g.n_blocking_defects;
        }, 0) / defects
      : null;
    const contested = eligible.filter((g) => g.contested);
    const flipOf = (g) => g.curve.find((c) => c.n === N)?.proxy_flip_rate ?? 0;
    curve.push({
      n: N,
      blocking_recall: recall,
      n_groups: eligible.length,
      n_defects: defects,
      // Both views, always: over every group, and over only those that are
      // genuinely contested. The first is diluted by groups that never block.
      proxy_flip_rate: eligible.length ? eligible.reduce((s, g) => s + flipOf(g), 0) / eligible.length : null,
      proxy_flip_rate_contested: contested.length
        ? contested.reduce((s, g) => s + flipOf(g), 0) / contested.length : null,
      n_contested: contested.length,
    });
  }

  const at = (n) => curve.find((p) => p.n === n) ?? null;
  const singletons = per_group.flatMap((g) =>
    g.singleton_blocking.map((s) => ({ item_id: g.item_id, lens_id: g.lens_id, ...s })));

  return {
    per_group,
    aggregate: {
      n_groups: per_group.length,
      n_items: new Set(per_group.map((g) => g.item_id)).size,
      n_defects: per_group.reduce((s, g) => s + g.n_defects, 0),
      n_blocking_defects: per_group.reduce((s, g) => s + g.n_blocking_defects, 0),
      n_contested_groups: per_group.filter((g) => g.contested).length,
      curve,
      // The number that gates the decision: what the 2nd sample adds in blocking recall.
      marginal_second_sample: (at(1)?.blocking_recall == null || at(2)?.blocking_recall == null)
        ? null : at(2).blocking_recall - at(1).blocking_recall,
      flatten_point: flattenPoint(curve, opts),
      // Blocking defects that only a single draw ever produced, listed in full: at
      // N=1 these are exactly what is at risk, and the report should name them
      // rather than compress them into a rate.
      singleton_blocking: singletons,
      n_singleton_blocking: singletons.length,
      oracle: "self-consistency — semantic union of all draws (corpus is unlabeled)",
      matcher: `findingSimilarity overlap ≥ ${opts.threshold ?? DEFAULT_SIMILARITY}`,
      scope: "detection output only — no verifier, no lane, no panel gate; blocking = severity critical/major",
    },
  };
}

/**
 * Project detection stage-run envelopes into analysis groups. Every replicate's
 * `output.per_sample` arrays are pooled as independent draws for that fixture, so R
 * replicates at `samples: 2` give D = 2R.
 *
 * Errored envelopes are DROPPED, not read as empty: a replay that failed found
 * nothing because it did not run, and counting that as a clean draw would depress
 * every rate here. Same fail-visible rule reliability.mjs and stage-run.mjs apply.
 */
export function envelopesToGroups(envelopes) {
  const byFixture = new Map();
  for (const e of envelopes || []) {
    if (!e || e.stage_id !== "detection" || e.status !== "ok") continue;
    const perSample = e.output?.per_sample;
    if (!Array.isArray(perSample)) continue;
    const ref = e.fixture_ref ?? "";
    if (!byFixture.has(ref)) {
      // fixture_ref for detection is `${item}::detection::${lens_id}` (stageInstanceKey).
      const parts = String(ref).split("::");
      byFixture.set(ref, {
        item_id: e.item_id ?? parts[0] ?? null,
        lens_id: parts[2] ?? null,
        fixture_ref: ref,
        draws: [],
      });
    }
    for (const s of perSample) byFixture.get(ref).draws.push(Array.isArray(s) ? s : []);
  }
  return [...byFixture.values()];
}

// --- store-backed CLI -------------------------------------------------------

async function main() {
  const { GitFsStore } = await import("./store.mjs");
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  if (!args.out || !args["stage-version"]) {
    console.error("usage: sample-count-analysis.mjs --out <results-repo> --stage-version <v> [--threshold 0.3] [--scorer-id sample-count-v1]");
    process.exit(2);
  }
  const store = new GitFsStore(args.out);
  const version = args["stage-version"];
  const scorerId = args["scorer-id"] ?? "sample-count-v1";
  const threshold = args.threshold != null ? Number(args.threshold) : DEFAULT_SIMILARITY;

  const envelopes = store.listStageRunIds(version)
    .flatMap((runId) => store.listStageRun(version, runId));
  const groups = envelopesToGroups(envelopes);
  if (groups.length === 0) { console.error(`no ok detection envelopes in stage-version ${version}`); process.exit(1); }

  const { per_group, aggregate } = computeSampleCount(groups, { threshold });
  store.putStageScore(version, scorerId, {
    scorer_id: scorerId, scorer_version: "sample-count-v1", stage: "detection",
    computed: new Date().toISOString(), stage_version: version,
    threshold, per_group, aggregate,
  });

  const one = aggregate.curve.find((c) => c.n === 1);
  const two = aggregate.curve.find((c) => c.n === 2);
  const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  console.log(
    `sample-count: groups=${aggregate.n_groups} blocking_defects=${aggregate.n_blocking_defects} ` +
    `recall@1=${pct(one?.blocking_recall)} recall@2=${pct(two?.blocking_recall)} ` +
    `marginal_2nd=${pct(aggregate.marginal_second_sample)} ` +
    `flip@1=${pct(one?.proxy_flip_rate_contested)} (contested ${aggregate.n_contested_groups}) ` +
    `singleton_blocking=${aggregate.n_singleton_blocking}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("sample-count-analysis failed:", e); process.exit(1); });
}
