// stage-run — replay ONE review stage against its frozen fixtures, K times, to
// measure that stage's decision stability in isolation (Mode A). The stage-level
// analogue of run.mjs: where run.mjs loops corpus items through the panel, this
// loops a `stage-fixtures/<version>` corpus through a STAGE adapter
// (stage-adapters.mjs), writing a stage-run envelope per fixture that carries
// `stage_id` + `fixture_ref` (the stageInstanceKey replayed). One invocation = one
// replicate (run_id); K replicates = K invocations, idempotently resumable.
//
// The gate stage is pure (free, deterministic); detection/verifier invoke the model.
//
// Usage:
//   node stage-run.mjs --out <results-repo> --stage-version <v> --stage <gate|detection|verifier>
//        [--run-id <id>] [--repo-source <dir>] [--no-repo-context]

import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageInstanceKey } from "./stage-artifacts.mjs";
import { STAGE_ADAPTERS } from "./stage-adapters.mjs";
import { sumExecutions } from "../metrics.mjs";

/**
 * Replay every fixture of `stage` in `stageVersion` once under `runId`. Pure of
 * clock/argv (the caller passes `timestamp`), so it is unit-testable end-to-end
 * with the pure gate adapter. Resumable: a fixture already recorded for this run_id
 * is skipped. Returns a summary. An adapter/replay throw is recorded as an `error`
 * envelope (fail-visible), not dropped.
 */
export async function runStage({ store, stageVersion, stage, runId, adapter, timestamp, repoSource = null, repoCache = null, env = process.env }) {
  const fixtures = store.listStageArtifacts(stageVersion).filter((a) => a && a.stage === stage);
  const summary = { stage, run_id: runId, stage_version: stageVersion, total: fixtures.length, ok: 0, error: 0, skipped: 0, cost_usd: 0 };

  for (const fixture of fixtures) {
    const fixtureRef = stageInstanceKey(fixture);
    if (store.hasStageRun(stageVersion, runId, fixtureRef)) { summary.skipped++; continue; }

    const stub = { run_id: runId, stage_id: stage, fixture_ref: fixtureRef, item_id: fixture.item_id, config_hash: fixture.provenance?.config_hash ?? null, stage_version: stageVersion, timestamp };
    let envelope;
    try {
      const prepared = await adapter.prepareInput(fixture, { store, version: stageVersion, repoSource, repoCache });
      const { output, sessionLog } = await adapter.runReplica(prepared, { env });
      const c = sumExecutions(sessionLog ?? [], "review");
      envelope = { ...stub, status: "ok", reason: null, cost_usd: c.costUsd, weighted_tokens: c.weightedTokens, raw_tokens: c.tokens, duration_ms: c.durationMs, turns: c.turns, calls: c.calls, output, error: null };
      summary.ok++; summary.cost_usd += c.costUsd || 0;
    } catch (e) {
      envelope = { ...stub, status: "error", reason: "exception", cost_usd: 0, weighted_tokens: 0, raw_tokens: 0, duration_ms: 0, turns: 0, calls: 0, output: null, error: { message: e.message, kind: "exception" } };
      summary.error++;
    }
    store.putStageRun(stageVersion, runId, fixtureRef, envelope);
  }
  return summary;
}

// --- store-backed CLI -------------------------------------------------------

const nowIso = () => new Date().toISOString();

async function main() {
  const { GitFsStore } = await import("./store.mjs");
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) { const n = process.argv[i + 1]; if (n === undefined || n.startsWith("--")) args[process.argv[i].slice(2)] = true; else { args[process.argv[i].slice(2)] = n; i++; } }
  }
  if (!args.out || !args["stage-version"] || !args.stage) {
    console.error("usage: stage-run.mjs --out <repo> --stage-version <v> --stage <gate|detection|verifier> [--run-id <id>] [--repo-source <dir>] [--no-repo-context]");
    process.exit(2);
  }
  const adapter = STAGE_ADAPTERS[args.stage];
  if (!adapter) {
    console.error(`no adapter for stage "${args.stage}" — available: ${Object.keys(STAGE_ADAPTERS).join(", ")} (detection/verifier land next)`);
    process.exit(2);
  }
  const store = new GitFsStore(args.out);
  const stageVersion = args["stage-version"];
  const runId = args["run-id"] ?? `${nowIso().replace(/[:.]/g, "-")}__stage-${args.stage}`;
  const repoSource = args["no-repo-context"] ? null : (args["repo-source"] ? path.resolve(args["repo-source"]) : null);
  const repoCache = path.join(tmpdir(), "eval-repo-cache");

  const s = await runStage({ store, stageVersion, stage: args.stage, runId, adapter, timestamp: nowIso(), repoSource, repoCache, env: process.env });
  console.log(`stage-run ${runId}: stage=${s.stage} total=${s.total} ok=${s.ok} error=${s.error} skipped=${s.skipped} cost=$${(s.cost_usd || 0).toFixed(2)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("stage-run crashed:", e); process.exit(1); });
}
