// stage-reliability — per-STAGE cross-run reliability (Mode A task 5). The
// stage-level analogue of reliability.mjs: given K replicate stage-runs of ONE
// stage over its fixtures (stage-run.mjs, K run_ids), does each fixture reach the
// SAME stage decision across replays? A validity-free consistency signal, per
// stage, reported as a VECTOR — not one whole-panel scalar.
//
// Metric per stage (deliberate — see reliability.mjs's note on why κ is only for
// the closed binary):
//   - gate      binary block/approve  → flip-rate + Fleiss κ
//   - verifier  binary drop/keep      → flip-rate + Fleiss κ   (drop = the gate effect)
//   - detection OPEN-ENDED finding set → positive OVERLAP (mean pairwise Jaccard of
//     the union finding-key sets). κ is mis-specified here — the negative class is
//     unbounded — so overlap is used, exactly as reliability.mjs's header warns.
//
// Pure core (decisionForStage / computeStageReliability / fleiss reuse) is exported
// and unit-tested; the store-backed CLI is a thin wrapper.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { fleissKappaBinary } from "./reliability.mjs";

const findingKey = (f) => `${f?.file ?? ""}::${String(f?.summary ?? "").toLowerCase().trim()}`;

/**
 * The comparable decision one stage-run envelope produced, or null to EXCLUDE this
 * replay (an errored/no-output replay is not a decision — never launder it into the
 * data, the same rule reliability.mjs applies to infra-failed items):
 *   gate      → "block" | "approve"
 *   verifier  → "drop" | "keep"        (null if the verifier errored → output.error)
 *   detection → string[] of finding keys (the union set)   (null if the replay errored)
 */
export function decisionForStage(stage, envelope) {
  if (!envelope || envelope.status !== "ok" || !envelope.output) return null;
  const o = envelope.output;
  if (stage === "gate") return o.verdict === "block" ? "block" : "approve";
  if (stage === "verifier") return o.error ? null : (o.dropped ? "drop" : "keep");
  if (stage === "detection") return Array.isArray(o.union) ? o.union.map(findingKey) : null;
  return null;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1; // both found nothing = perfectly consistent
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : inter / uni;
}
function meanPairwiseJaccard(sets) {
  let sum = 0, n = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { sum += jaccard(sets[i], sets[j]); n++; }
  return n ? sum / n : 1;
}

/**
 * Per-stage reliability over K replicate stage-runs. `runs` = [{ runId, decisions:
 * { fixtureRef: <decision|null> } }]. Only fixtures present with a NON-null decision
 * in EVERY run are scored (fair comparison + κ needs a fixed rater count K); the
 * rest are reported as excluded. Returns { stage, method, per_fixture, aggregate }.
 */
export function computeStageReliability(stage, runs) {
  const list = (runs || []).filter((r) => r && r.decisions);
  const K = list.length;
  if (K < 2) return { stage, method: "n/a", per_fixture: {}, aggregate: { n: 0, k_runs: K, note: "need ≥2 runs" } };

  const refSets = list.map((r) => new Set(Object.entries(r.decisions).filter(([, v]) => v != null).map(([k]) => k)));
  const common = [...refSets[0]].filter((ref) => refSets.every((s) => s.has(ref))).sort();
  const excluded = new Set(list.flatMap((r) => Object.keys(r.decisions))).size - common.length;

  if (stage === "detection") {
    const per_fixture = {};
    let jsum = 0;
    for (const ref of common) {
      const sets = list.map((r) => new Set(r.decisions[ref]));
      const j = meanPairwiseJaccard(sets);
      per_fixture[ref] = { mean_jaccard: j, stable: j === 1, sizes: sets.map((s) => s.size) };
      jsum += j;
    }
    return {
      stage, method: "positive overlap — mean pairwise Jaccard of union finding-key sets",
      per_fixture,
      aggregate: { n: common.length, k_runs: K, items_excluded: excluded, mean_jaccard: common.length ? jsum / common.length : 1 },
    };
  }

  // binary (gate / verifier)
  const [A, B] = stage === "verifier" ? ["drop", "keep"] : ["block", "approve"];
  const per_fixture = {};
  const counts = [];
  let unstable = 0;
  for (const ref of common) {
    const vals = list.map((r) => r.decisions[ref]);
    const a = vals.filter((v) => v === A).length;
    const b = vals.filter((v) => v === B).length;
    const stable = a === 0 || b === 0;
    if (!stable) unstable++;
    per_fixture[ref] = { stable, [A]: a, [B]: b, n_runs: K };
    counts.push({ block: a, approve: b }); // map A/B → fleissKappaBinary's slots
  }
  return {
    stage, method: `Fleiss κ over replicate binary ${stage} decision (${A}/${B})`,
    per_fixture,
    aggregate: { n: common.length, k_runs: K, items_excluded: excluded, flip_rate: common.length ? unstable / common.length : 0, kappa: fleissKappaBinary(counts) },
  };
}

// --- store-backed CLI -------------------------------------------------------

async function main() {
  const { GitFsStore } = await import("./store.mjs");
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  if (!args.out || !args["stage-version"] || !args.stage) {
    console.error("usage: stage-reliability.mjs --out <repo> --stage-version <v> --stage <gate|verifier|detection> [--scorer-id]");
    process.exit(2);
  }
  const store = new GitFsStore(args.out);
  const stage = args.stage;
  const version = args["stage-version"];
  const scorerId = args["scorer-id"] ?? `stage-reliability-${stage}`;

  // Each stage-run invocation (one run_id) replays ONE stage, so a run dir's
  // envelopes are homogeneous; keep only dirs whose envelopes are THIS stage.
  const runs = [];
  for (const runId of store.listStageRunIds(version)) {
    const envs = store.listStageRun(version, runId).filter((e) => e && e.stage_id === stage);
    if (envs.length === 0) continue;
    const decisions = {};
    for (const e of envs) decisions[e.fixture_ref] = decisionForStage(stage, e);
    runs.push({ runId, decisions });
  }
  if (runs.length < 2) { console.error(`need ≥2 replicate ${stage} runs, found ${runs.length}`); process.exit(1); }

  const result = computeStageReliability(stage, runs);
  const scoreJson = {
    scorer_id: scorerId, scorer_version: "stage-reliability-v1", stage,
    computed: new Date().toISOString(), stage_version: version,
    run_ids: runs.map((r) => r.runId), ...result,
  };
  store.putStageScore(version, scorerId, scoreJson);
  const a = result.aggregate;
  const headline = stage === "detection"
    ? `mean_jaccard=${(a.mean_jaccard ?? 0).toFixed(3)}`
    : `flip_rate=${(a.flip_rate ?? 0).toFixed(3)} kappa=${a.kappa ?? "n/a"}`;
  console.log(`stage-reliability[${stage}]: n=${a.n} k_runs=${a.k_runs} ${headline} (excluded ${a.items_excluded})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("stage-reliability failed:", e); process.exit(1); });
}
