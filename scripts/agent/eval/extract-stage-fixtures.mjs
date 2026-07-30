// extract-stage-fixtures — harvest a `stage-fixtures/<version>` corpus from a
// CAPTURED run, OFFLINE (no model calls). Mode A prerequisite (task 3).
//
// A normal run already stores everything needed: the item payload carries
// `stageDetail` (per-sample findings + per-finding verifier verdicts, via the
// reviewer adapter), the corpus holds the frozen inputs (diff/issue/changed-files/
// review_commit), and the run's config snapshot inlines each lens's rubric + model
// + samples. So this projects stored runs into validated stage artifacts with
// `buildStageArtifacts`, writes their large inputs as deduped content blobs, and
// stores each artifact write-once keyed by `stageInstanceKey`. Re-runnable and
// idempotent: the same frozen input yields the same key and is skipped.
//
// Only `status: "ok"` items are harvested — an infra/error item never actually
// ran the reviewer, so its verdict is contaminated (same exclusion reliability.mjs
// makes).
//
// Usage (no model calls):
//   node extract-stage-fixtures.mjs --out <results-repo> --run-id <id> [--stage-version <v>]
//   node extract-stage-fixtures.mjs --out <results-repo> --config-hash <h> --corpus-version <v> [--stage-version <v>]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStageArtifacts } from "./stage-capture.mjs";
import { stageInstanceKey } from "./stage-artifacts.mjs";

/**
 * Assemble the `ctx` buildStageArtifacts needs from stored facts, writing each
 * large input as a content blob (deduped) to get its BlobRef. Store-backed (the
 * blob writes are intrinsic to producing the refs).
 */
export function itemContext({ store, version, runJson, snapshot, corpusInput, envelope }) {
  const diff = store.putStageBlob(version, corpusInput.diff ?? "");
  const issue = corpusInput.issueSpec ? store.putStageBlob(version, corpusInput.issueSpec) : null;
  // Canonical changed-files text = exactly what the panel was handed (join+trailing \n).
  const changed_files = store.putStageBlob(version, (corpusInput.changedFiles ?? []).join("\n") + "\n");
  const rubricByLens = {};
  const lensMeta = {};
  for (const l of snapshot.lenses ?? []) {
    rubricByLens[l.id] = store.putStageBlob(version, l.rubric_text ?? "");
    lensMeta[l.id] = { model: l.model, samples: l.samples, title: l.title, needsIssueSpec: l.needsIssueSpec };
  }
  return {
    item_id: envelope.item_id,
    provenance: {
      run_id: runJson.run_id,
      config_hash: runJson.config_hash,
      sdk_version: runJson.sdk_version,
      captured_at: envelope.timestamp,
    },
    repo_commit: corpusInput.meta?.review_commit ?? null,
    changed_files: corpusInput.changedFiles ?? [],
    refs: { diff, issue, changed_files, rubricByLens },
    lensMeta,
  };
}

/**
 * Project one captured item into stage fixtures and store them. Returns a small
 * summary. Non-ok items are skipped (contaminated verdict), as are items with no
 * payload. buildStageArtifacts asserts each record, so a malformed projection
 * throws here rather than silently storing junk.
 */
export function extractItemFixtures({ store, version, runJson, snapshot, corpusInput, envelope, payload, maxVerifier }) {
  if (!envelope || envelope.status !== "ok") return { item_id: envelope?.item_id, skipped: true, reason: envelope?.status ?? "missing" };
  if (!payload) return { item_id: envelope.item_id, skipped: true, reason: "no-payload" };
  const ctx = itemContext({ store, version, runJson, snapshot, corpusInput, envelope });
  let arts = buildStageArtifacts(payload, ctx);

  // Cost cap: the verifier stage is O(findings) — one fixture per blocking finding —
  // and each fixture is replayed K times, so a pathological capture (the #521 pilot
  // raised 48) makes the replay explode. When maxVerifier is set, keep only the first
  // N verifier fixtures by a STABLE key (instanceKey sort), so the subset is
  // deterministic across extractions and the dropped count is reported, not silent.
  let verifierDropped = 0;
  if (maxVerifier > 0) {
    const verifier = arts.filter((a) => a.stage === "verifier").sort((x, y) => stageInstanceKey(x).localeCompare(stageInstanceKey(y)));
    if (verifier.length > maxVerifier) {
      const keep = new Set(verifier.slice(0, maxVerifier).map(stageInstanceKey));
      verifierDropped = verifier.length - maxVerifier;
      arts = arts.filter((a) => a.stage !== "verifier" || keep.has(stageInstanceKey(a)));
    }
  }

  const byStage = { detection: 0, verifier: 0, gate: 0 };
  for (const art of arts) {
    store.putStageArtifact(version, stageInstanceKey(art), art);
    byStage[art.stage] = (byStage[art.stage] ?? 0) + 1;
  }
  return { item_id: envelope.item_id, count: arts.length, byStage, verifierDropped };
}

/** Default fixture-corpus version — grouped by corpus + judge identity, so repeated
 * extractions of the same judge/corpus accrete idempotently into one corpus. */
export function defaultStageVersion(runJson) {
  const short = String(runJson.config_hash ?? "").replace(/^sha256:/, "").slice(0, 12);
  return `${runJson.corpus_version}__${short}`;
}

// --- store-backed CLI -------------------------------------------------------

async function main() {
  const { GitFsStore } = await import("./store.mjs");
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) { args[process.argv[i].slice(2)] = process.argv[i + 1]; i++; }
  }
  if (!args.out || (!args["run-id"] && !(args["config-hash"] && args["corpus-version"]))) {
    console.error("usage: extract-stage-fixtures.mjs --out <repo> (--run-id <id> | --config-hash <h> --corpus-version <v>) [--stage-version <v>]");
    process.exit(2);
  }
  const store = new GitFsStore(args.out);
  const runIds = args["run-id"]
    ? [args["run-id"]]
    : store.listRuns({ configHash: args["config-hash"], corpusVersion: args["corpus-version"] });
  if (runIds.length === 0) { console.error("no matching runs"); process.exit(1); }

  const maxVerifier = Number(args["max-verifier-fixtures"] ?? 0) || 0;
  const totals = { detection: 0, verifier: 0, gate: 0, items: 0, skipped: 0, verifierDropped: 0 };
  let version = args["stage-version"];
  for (const runId of runIds) {
    const run = store.getRun(runId);
    if (!run) { console.error(`  ! run ${runId} not found, skipping`); continue; }
    const { runJson, configSnapshot } = run;
    version = version ?? defaultStageVersion(runJson);
    for (const itemId of store.listItems(runId)) {
      const got = store.getItem(runId, itemId);
      if (!got) continue;
      const corpusInput = store.getCorpusItemInput(itemId);
      if (!corpusInput) { console.error(`  ! ${itemId}: no corpus input, skipping`); totals.skipped++; continue; }
      const r = extractItemFixtures({
        store, version, runJson, snapshot: configSnapshot, corpusInput,
        envelope: got.envelope, payload: got.payload, maxVerifier,
      });
      if (r.skipped) { totals.skipped++; process.stdout.write(`  = ${itemId}: skipped (${r.reason})\n`); continue; }
      totals.items++;
      totals.verifierDropped += r.verifierDropped ?? 0;
      for (const s of ["detection", "verifier", "gate"]) totals[s] += r.byStage[s] ?? 0;
      const dropNote = r.verifierDropped ? ` [capped: dropped ${r.verifierDropped} verifier]` : "";
      process.stdout.write(`  + ${itemId}: ${r.count} (det ${r.byStage.detection}, ver ${r.byStage.verifier}, gate ${r.byStage.gate})${dropNote}\n`);
    }
  }
  const capNote = maxVerifier ? ` (verifier capped at ${maxVerifier}/item; dropped ${totals.verifierDropped})` : "";
  console.log(`stage-fixtures "${version}": ${totals.items} item(s) → detection ${totals.detection}, verifier ${totals.verifier}, gate ${totals.gate}; skipped ${totals.skipped}${capNote}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("extract-stage-fixtures failed:", e); process.exit(1); });
}
