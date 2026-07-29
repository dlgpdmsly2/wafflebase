// GitFsStore — the ArtifactStore implementation over a local checkout of the
// results repo (wafflebase-agent-eval). Pure fs + gzip; git commit is a separate
// concern (optional `commit()` helper). Swapping to an object store later = a new
// class with the same surface — the runner/scorer/adapter never change.
//
// Contract highlights (schema doc §4):
//   - runs/ is write-once at the ITEM level: putItem throws if the item exists
//     (use hasItem to skip on resume). run.json is a mutable status summary of an
//     immutable item set; config.snapshot.json is write-once (it is identity).
//   - scores/ is re-scoreable (overwrite ok): per-run vs by-config by scope.
//   - transcripts are gzip-compressed on disk (git-bloat guard).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import path from "node:path";

// Colon is legal in POSIX paths but not on all filesystems; keep segments safe
// (config_hash carries a "sha256:" prefix that becomes "sha256-" on disk).
const safeSeg = (s) => String(s).replace(/[:/\\]/g, "-");

export class GitFsStore {
  constructor(root) {
    if (!root) throw new Error("GitFsStore needs a results-repo root path");
    this.root = path.resolve(root);
  }

  _p(...parts) { return path.join(this.root, ...parts); }
  _readJson(p) { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; }
  _writeJson(p, obj) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  }

  // --- runs -----------------------------------------------------------------

  _runDir(runId) { return this._p("runs", safeSeg(runId)); }
  _itemDir(runId, itemId) { return path.join(this._runDir(runId), "items", safeSeg(itemId)); }

  /** Write/refresh run.json; write config.snapshot.json once (identity). */
  putRun(runId, { runJson, configSnapshot }) {
    this._writeJson(path.join(this._runDir(runId), "run.json"), runJson);
    const snapPath = path.join(this._runDir(runId), "config.snapshot.json");
    if (configSnapshot && !existsSync(snapPath)) this._writeJson(snapPath, configSnapshot);
  }

  getRun(runId) {
    const runJson = this._readJson(path.join(this._runDir(runId), "run.json"));
    if (!runJson) return null;
    return { runJson, configSnapshot: this._readJson(path.join(this._runDir(runId), "config.snapshot.json")) };
  }

  hasItem(runId, itemId) {
    return existsSync(path.join(this._itemDir(runId, itemId), "envelope.json"));
  }

  /** Write-once per item. Throws if it already exists (immutability); the runner
   * calls hasItem() to skip already-done items on resume. `transcript` is any
   * JSON value, stored gzip-compressed. */
  putItem(runId, itemId, { envelope, payload, transcript }) {
    if (this.hasItem(runId, itemId)) {
      throw new Error(`putItem: ${runId}/${itemId} already written (runs/ is write-once)`);
    }
    const dir = this._itemDir(runId, itemId);
    this._writeJson(path.join(dir, "envelope.json"), envelope);
    this._writeJson(path.join(dir, "payload.json"), payload);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "transcript.json.gz"), gzipSync(Buffer.from(JSON.stringify(transcript ?? null))));
  }

  getItem(runId, itemId) {
    const dir = this._itemDir(runId, itemId);
    const envelope = this._readJson(path.join(dir, "envelope.json"));
    if (!envelope) return null;
    const payload = this._readJson(path.join(dir, "payload.json"));
    const tPath = path.join(dir, "transcript.json.gz");
    const transcript = existsSync(tPath) ? JSON.parse(gunzipSync(readFileSync(tPath)).toString("utf8")) : null;
    return { envelope, payload, transcript };
  }

  listItems(runId) {
    const dir = path.join(this._runDir(runId), "items");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  /** Run ids, optionally filtered to a (configHash, corpusVersion) group — the
   * replicates a cross-run reliability scorer aggregates over. */
  listRuns({ configHash, corpusVersion } = {}) {
    const dir = this._p("runs");
    if (!existsSync(dir)) return [];
    const out = [];
    for (const seg of readdirSync(dir).sort()) {
      const rj = this._readJson(path.join(dir, seg, "run.json"));
      if (!rj) continue;
      if (configHash && rj.config_hash !== configHash) continue;
      if (corpusVersion && rj.corpus_version !== corpusVersion) continue;
      out.push(rj.run_id ?? seg);
    }
    return out;
  }

  // --- scores (re-scoreable) ------------------------------------------------

  _scorePath({ scope, runId, configHash, corpusVersion }, scorerId) {
    if (scope === "per-run") return this._p("scores", "per-run", safeSeg(runId), `${safeSeg(scorerId)}.json`);
    if (scope === "cross-run") {
      return this._p("scores", "by-config", `${safeSeg(configHash)}__${safeSeg(corpusVersion)}`, `${safeSeg(scorerId)}.json`);
    }
    throw new Error(`putScore/getScore: scope must be "per-run" or "cross-run" (got ${scope})`);
  }

  putScore(key, scorerId, scoreJson) { this._writeJson(this._scorePath(key, scorerId), scoreJson); }
  getScore(key, scorerId) { return this._readJson(this._scorePath(key, scorerId)); }

  // --- configs (judge manifests, config-as-code) ----------------------------

  putConfig(configId, manifest) { this._writeJson(this._p("configs", `${safeSeg(configId)}.json`), manifest); }
  getConfig(configId) { return this._readJson(this._p("configs", `${safeSeg(configId)}.json`)); }

  // --- corpus ---------------------------------------------------------------

  _corpusItemDir(itemId) { return this._p("corpus", "items", safeSeg(itemId)); }

  /** Store one frozen corpus item's inputs. `issueSpec` optional. */
  putCorpusItem(itemId, { meta, diff, changedFiles, issueSpec }) {
    const dir = this._corpusItemDir(itemId);
    this._writeJson(path.join(dir, "meta.json"), meta);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "diff.patch"), String(diff ?? ""));
    writeFileSync(path.join(dir, "changed-files.txt"), (changedFiles ?? []).join("\n") + "\n");
    if (issueSpec != null && issueSpec !== "") writeFileSync(path.join(dir, "issue-spec.md"), String(issueSpec));
  }

  /** Read one item's inputs for the runner (diff/changed-files/issue-spec). */
  getCorpusItemInput(itemId) {
    const dir = this._corpusItemDir(itemId);
    const metaPath = path.join(dir, "meta.json");
    if (!existsSync(metaPath)) return null;
    const issuePath = path.join(dir, "issue-spec.md");
    const cfPath = path.join(dir, "changed-files.txt");
    return {
      meta: this._readJson(metaPath),
      diff: readFileSync(path.join(dir, "diff.patch"), "utf8"),
      changedFiles: existsSync(cfPath) ? readFileSync(cfPath, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : [],
      issueSpec: existsSync(issuePath) ? readFileSync(issuePath, "utf8") : null,
    };
  }

  // Corpus versions are named, immutable snapshots → one manifest file per
  // version (corpus/manifests/<version>.json), items shared under corpus/items/.
  putCorpusManifest(corpusVersion, manifestJson) {
    this._writeJson(this._p("corpus", "manifests", `${safeSeg(corpusVersion)}.json`), manifestJson);
  }

  /** The item index for a corpus version (its manifest's `items` array). */
  getCorpus(corpusVersion) {
    const m = this._readJson(this._p("corpus", "manifests", `${safeSeg(corpusVersion)}.json`));
    return m ? (Array.isArray(m.items) ? m.items : []) : null;
  }

  // --- stage fixtures (Mode A: frozen per-stage inputs + captured decisions) --
  // A `stage-fixtures/<version>` corpus of validated stage artifacts (see
  // eval/stage-artifacts.md), harvested from a captured run by
  // extract-stage-fixtures.mjs. Large inputs (diff/rubric/issue/changed-files) are
  // content-addressed into blobs/ and referenced by BlobRef, so the many artifacts
  // of one item share one diff blob. Keys are opaque here (item×stage×instance);
  // the caller passes `stageInstanceKey(artifact)` — the store stays schema-agnostic.

  _stageDir(version) { return this._p("stage-fixtures", safeSeg(version)); }

  /** Content-address a stage input blob; write once (dedup across items/lenses);
   * return its BlobRef `{sha256, bytes}`. sha256 == contentHash() format. */
  putStageBlob(version, content) {
    const s = String(content ?? "");
    const sha256 = `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;
    const p = path.join(this._stageDir(version), "blobs", `${safeSeg(sha256)}.blob`);
    if (!existsSync(p)) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); }
    return { sha256, bytes: Buffer.byteLength(s) };
  }

  getStageBlob(version, sha256) {
    const p = path.join(this._stageDir(version), "blobs", `${safeSeg(sha256)}.blob`);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  _stageArtifactPath(version, key) {
    const fname = createHash("sha256").update(String(key), "utf8").digest("hex");
    return path.join(this._stageDir(version), "artifacts", `${fname}.json`);
  }

  /** Write-once per (item×stage×instance) `key`. Idempotent: a re-extraction of the
   * same frozen input skips rather than throws (fixtures are immutable). Returns key. */
  putStageArtifact(version, key, artifact) {
    const p = this._stageArtifactPath(version, key);
    if (!existsSync(p)) this._writeJson(p, artifact);
    return key;
  }

  getStageArtifact(version, key) { return this._readJson(this._stageArtifactPath(version, key)); }

  /** Every stage artifact for a version (scans artifacts/). */
  listStageArtifacts(version) {
    const dir = path.join(this._stageDir(version), "artifacts");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
      .map((f) => this._readJson(path.join(dir, f)));
  }

  // --- stage runs (Mode A: replicate replays of one STAGE against its fixtures) -
  // A stage-run is one replay of a stage adapter over a stage-fixtures corpus under
  // a run_id; K replicates = K run_ids. Envelopes carry `stage_id` + `fixture_ref`
  // (the stageInstanceKey replayed), so a per-stage reliability scorer groups
  // envelopes across run_ids by fixture_ref. Layout: stage-runs/<version>/<runId>/.

  _stageRunDir(version, runId) { return this._p("stage-runs", safeSeg(version), safeSeg(runId)); }
  _stageRunPath(version, runId, fixtureRef) {
    const fname = createHash("sha256").update(String(fixtureRef), "utf8").digest("hex");
    return path.join(this._stageRunDir(version, runId), `${fname}.json`);
  }

  hasStageRun(version, runId, fixtureRef) { return existsSync(this._stageRunPath(version, runId, fixtureRef)); }

  /** Write-once per (runId, fixtureRef) — one replay per fixture per run. The
   * runner calls hasStageRun() to skip on resume. */
  putStageRun(version, runId, fixtureRef, envelope) {
    const p = this._stageRunPath(version, runId, fixtureRef);
    if (existsSync(p)) throw new Error(`putStageRun: ${version}/${runId}/${fixtureRef} already written (write-once)`);
    this._writeJson(p, envelope);
  }

  getStageRun(version, runId, fixtureRef) { return this._readJson(this._stageRunPath(version, runId, fixtureRef)); }

  /** All envelopes for one stage-run. */
  listStageRun(version, runId) {
    const dir = this._stageRunDir(version, runId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => this._readJson(path.join(dir, f)));
  }

  /** Run dirs under a stage-fixtures version (the K replicates to aggregate over). */
  listStageRunIds(version) {
    const dir = this._p("stage-runs", safeSeg(version));
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  /** Per-stage reliability score for a stage-fixtures version (re-scoreable). */
  putStageScore(version, scorerId, scoreJson) {
    this._writeJson(path.join(this._stageDir(version), "scores", `${safeSeg(scorerId)}.json`), scoreJson);
  }
  getStageScore(version, scorerId) {
    return this._readJson(path.join(this._stageDir(version), "scores", `${safeSeg(scorerId)}.json`));
  }

  // --- labels (Track B — reserved) ------------------------------------------

  getLabels(corpusVersion, itemId) {
    return this._readJson(this._p("labels", safeSeg(corpusVersion), `${safeSeg(itemId)}.json`));
  }
}
