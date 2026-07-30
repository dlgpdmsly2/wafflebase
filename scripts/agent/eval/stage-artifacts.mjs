// Stage-artifact schema + validator (Mode A, stage-isolated reliability).
//
// A "stage artifact" is the FROZEN INPUT + OBSERVED OUTPUT of ONE review-panel
// stage, captured during a normal run so the stage can later be replayed in
// isolation K times and its decision's flip-rate/κ measured (see
// eval/stage-artifacts.md for the full contract and rationale).
//
// The shipped review-panel.mjs pipeline has THREE model/decision stages — not
// the five the early design sketch listed:
//   - detection  — a lens sampled N× → union of raised findings (runLens + unionSamples)
//   - verifier   — refute one blocking finding → confirm/refute (verifyFinding + applyVerifications),
//                  run over TWO finding populations: `fresh` (this round) and
//                  `prior-round` (the Part-2 cross-round re-check). Same call shape,
//                  so ONE stage discriminated by `instance.population`, not two stages.
//                  INDEPENDENT (#573): the verifier is NOT given the diff — it re-grounds
//                  the facts from the repo (so `repo_commit` is load-bearing) and may only
//                  DROP a finding on a named `refutationGround` + a `file:line` citation,
//                  gated by the changed-file trust context (`allowPreExisting`).
//   - gate       — kept-finding set → block/approve (severity.classify + panel rollup);
//                  a PURE function, so its replay is a unit assertion, not a paid call.
// `rebuttal` / `adjudicator` are RESERVED (documented, not emitted) — the pipeline
// does not build them yet. The validator rejects them so a fixture from a future,
// unrecognized pipeline version fails loudly instead of validating by accident.
//
// Direction of failure: unlike the review logic (which fails toward BLOCKING),
// a validator's job is to catch a malformed fixture BEFORE it poisons a replay,
// so it fails toward REJECTION — it is strict and reports every problem it finds.
// Pure (no fs/SDK/clock); exported for reuse by the extractor, adapters, and tests.

import { KNOWN } from "../severity.mjs";
import { VERIFIER_SCHEMA } from "../review-panel.mjs";

export const STAGE_ARTIFACT_VERSION = "stage-artifacts/v1";

/** The stages the pipeline actually emits (the only ones the validator accepts). */
export const STAGES = ["detection", "verifier", "gate"];
/** Documented but NOT yet emitted — rejected with a clear "reserved" message. */
export const RESERVED_STAGES = ["rebuttal", "adjudicator"];

export const POPULATIONS = ["fresh", "prior-round"];          // verifier finding source
export const AGREEMENT = ["single", "identical", "partial", "disjoint"]; // compareSampleAgreement
// DERIVED from the pipeline's own VERIFIER_SCHEMA, never re-typed. The capture is a
// projection of the verifier's structured_output, so its accepted vocabulary must BE
// the verifier's — a hand-maintained copy drifts (and did: it lacked `unresolved` and
// `counterexample`, which failed the harvest AFTER a paid capture). Sourcing them from
// the schema makes that class of failure impossible; stage-artifacts.test.mjs asserts
// the coupling so the intent is visible. Verdict adds `unresolved` (#587: "couldn't
// settle"); refutationGround adds `counterexample` (#587: refute an absence claim by
// finding an example).
export const VERIFIER_VERDICTS = VERIFIER_SCHEMA.properties.verdict.enum;
export const VERIFIER_CONFIDENCE = VERIFIER_SCHEMA.properties.confidence.enum;
export const REFUTATION_GROUNDS = VERIFIER_SCHEMA.properties.refutationGround.enum;
export const GATE_VERDICTS = ["block", "approve"];
export const LENS_CONCLUSIONS = ["success", "failure", "skipped"];
export const SEVERITIES = KNOWN;                              // critical|major|minor|nit
export const FINDING_CONFIDENCE = ["high", "medium", "low"]; // detection finding confidence axis (#573)
export const CONFIDENCE_COUNT_KEYS = ["high", "medium", "low", "unknown"]; // confidenceCounts buckets

// --- small predicates --------------------------------------------------------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/** A content-addressed pointer into the stage-fixture store: `{sha256, bytes}`.
 * Big, shared inputs (diff / rubric / issue / changed-files) are referenced, not
 * inlined, so an item's many stage records dedup the identical blob. */
export function isBlobRef(v) {
  return isObj(v) && /^sha256:[0-9a-f]{64}$/.test(v.sha256 ?? "") && isNonNegInt(v.bytes);
}

/** A raised/kept finding — recorded AS PRODUCED (fidelity). Mirrors review-panel's
 * FINDING: `severity` + `summary` required, `file`/`evidence` optional. `severity`
 * is any string on purpose — the gate normalizes unknown→major downstream; a
 * fixture must preserve what the model actually emitted, not a normalized copy. */
export function isFinding(v) {
  return isObj(v) && isNonEmptyString(v.severity) && typeof v.summary === "string";
}

/** `{critical,major,minor,nit}` all non-negative ints (severityCounts output). */
export function isCounts(v) {
  return isObj(v) && SEVERITIES.every((s) => isNonNegInt(v[s]));
}

/** `{high,medium,low,unknown}` all non-negative ints (confidenceCounts output). */
export function isConfidenceCounts(v) {
  return isObj(v) && CONFIDENCE_COUNT_KEYS.every((k) => isNonNegInt(v[k]));
}

/** The verifier's changed-file trust context (changedFileContext output): whether
 * the changed-file list was authoritative (drives `allowPreExisting`), its true
 * length, and how many entries were listed after the 200-file cap. */
export function isChangedContext(v) {
  return isObj(v) && typeof v.authoritative === "boolean" && isNonNegInt(v.total) && isNonNegInt(v.listed_count);
}

// --- per-section validators (each pushes "path: message" strings) ------------

function checkProvenance(p, errs) {
  if (!isObj(p)) { errs.push("provenance: must be an object"); return; }
  if (!isNonEmptyString(p.run_id)) errs.push("provenance.run_id: required non-empty string");
  if (!isNonEmptyString(p.config_hash)) errs.push("provenance.config_hash: required non-empty string");
  if (!isNonEmptyString(p.sdk_version)) errs.push("provenance.sdk_version: required non-empty string");
  if (!isNonEmptyString(p.captured_at)) errs.push("provenance.captured_at: required non-empty ISO string");
  if (p.model !== undefined && !isNonEmptyString(p.model)) errs.push("provenance.model: must be a non-empty string when present");
}

// repo context is a git commit (materializeRepoAt), or null for diff-only replay.
const isRepoCommit = (v) => v === null || isNonEmptyString(v);

function checkDetection(art, errs) {
  const { instance: ins, input: inp, output: out } = art;
  if (!isNonEmptyString(ins?.lens_id)) errs.push("instance.lens_id: required for detection");

  if (!isObj(inp)) { errs.push("input: required object for detection"); }
  else {
    if (!isBlobRef(inp.rubric)) errs.push("input.rubric: required BlobRef");
    if (!isBlobRef(inp.diff)) errs.push("input.diff: required BlobRef");
    if (inp.issue !== null && !isBlobRef(inp.issue)) errs.push("input.issue: BlobRef or null");
    if (inp.changed_files !== null && !isBlobRef(inp.changed_files)) errs.push("input.changed_files: BlobRef or null");
    if (!isRepoCommit(inp.repo_commit)) errs.push("input.repo_commit: commit string or null (diff-only)");
    if (!(Number.isInteger(inp.samples) && inp.samples >= 1)) errs.push("input.samples: integer ≥ 1");
    // Lens replay params — so the fixture is SELF-CONTAINED for runLens (a lens's
    // needs_issue_spec cannot be recovered from whether an issue blob is present).
    if (!isNonEmptyString(inp.model)) errs.push("input.model: required non-empty string");
    if (!isNonEmptyString(inp.title)) errs.push("input.title: required non-empty string (lens systemPrompt framing)");
    if (typeof inp.needs_issue_spec !== "boolean") errs.push("input.needs_issue_spec: boolean");
  }

  if (!isObj(out)) { errs.push("output: required object for detection"); }
  else {
    if (!Array.isArray(out.union) || !out.union.every(isFinding)) errs.push("output.union: array of findings");
    if (!Array.isArray(out.per_sample) || !out.per_sample.every((s) => Array.isArray(s) && s.every(isFinding))) {
      errs.push("output.per_sample: array of finding-arrays (one per successful sample)");
    }
    if (!isNonNegInt(out.samples_run)) errs.push("output.samples_run: non-negative int");
    if (!isNonNegInt(out.samples_ok)) errs.push("output.samples_ok: non-negative int");
    if (!AGREEMENT.includes(out.agreement)) errs.push(`output.agreement: one of ${AGREEMENT.join("|")}`);
    if (!isCounts(out.severity_counts)) errs.push("output.severity_counts: {critical,major,minor,nit} ints");
    if (!isConfidenceCounts(out.confidence_counts)) errs.push("output.confidence_counts: {high,medium,low,unknown} ints");
  }
}

function checkVerifier(art, errs) {
  const { instance: ins, input: inp, output: out } = art;
  if (!isNonEmptyString(ins?.lens_id)) errs.push("instance.lens_id: required for verifier");
  if (!POPULATIONS.includes(ins?.population)) errs.push(`instance.population: one of ${POPULATIONS.join("|")}`);
  if (!isNonEmptyString(ins?.finding_key)) errs.push("instance.finding_key: required non-empty string");

  if (!isObj(inp)) { errs.push("input: required object for verifier"); }
  else {
    if (!isFinding(inp.finding)) errs.push("input.finding: required finding (the frozen finding under test)");
    if (!isBlobRef(inp.rubric)) errs.push("input.rubric: required BlobRef");
    if (inp.changed_files !== null && !isBlobRef(inp.changed_files)) errs.push("input.changed_files: BlobRef or null (source of the trust context)");
    if (!isChangedContext(inp.changed_context)) errs.push("input.changed_context: {authoritative:bool, total:int, listed_count:int}");
    if (!isRepoCommit(inp.repo_commit)) errs.push("input.repo_commit: commit string, or null — but diff-only STARVES the independent verifier (low fidelity)");
    if (!isNonEmptyString(inp.model)) errs.push("input.model: required non-empty string");
    if (!(Number.isInteger(inp.max_turns) && inp.max_turns >= 1)) errs.push("input.max_turns: integer ≥ 1 (VERIFIER_MAX_TURNS budget)");
    // Encode the #573 independence property into the contract: the verifier is
    // NOT given the diff. A fixture that still carries one is from the pre-#573
    // pipeline (or a mis-capture) and must be rejected, not silently replayed.
    if ("diff" in inp) errs.push("input.diff: MUST be absent — the independent verifier (#573) is not given the diff; it re-grounds from repo_commit");
  }

  if (!isObj(out)) { errs.push("output: required object for verifier"); return; }
  // A verifier call either decided (confirm/refute) or errored (→ finding KEPT).
  // Exactly one of {decision, error} is populated; `dropped` is the gate effect.
  const hasDecision = out.decision !== null && out.decision !== undefined;
  const hasError = out.error !== null && out.error !== undefined;
  if (hasDecision === hasError) errs.push("output: exactly one of {decision, error} must be set");
  if (hasDecision) {
    const d = out.decision;
    if (!isObj(d)) errs.push("output.decision: object when set");
    else {
      // Field names preserved AS PRODUCED by VERIFIER_SCHEMA (camelCase) — capture
      // is a projection of the model's structured_output, not a rename.
      if (!VERIFIER_VERDICTS.includes(d.verdict)) errs.push(`output.decision.verdict: one of ${VERIFIER_VERDICTS.join("|")}`);
      if (!VERIFIER_CONFIDENCE.includes(d.confidence)) errs.push(`output.decision.confidence: one of ${VERIFIER_CONFIDENCE.join("|")}`);
      if (typeof d.reason !== "string") errs.push("output.decision.reason: string");
      if (!REFUTATION_GROUNDS.includes(d.refutationGround)) errs.push(`output.decision.refutationGround: one of ${REFUTATION_GROUNDS.join("|")}`);
      if (!Array.isArray(d.groundedIn) || !d.groundedIn.every((s) => typeof s === "string")) {
        errs.push("output.decision.groundedIn: array of strings (file:line citations)");
      }
    }
  }
  if (hasError && !(isObj(out.error) && isNonEmptyString(out.error.message))) {
    errs.push("output.error: {message, kind?} object when set");
  }
  if (typeof out.dropped !== "boolean") errs.push("output.dropped: boolean (isDroppingVerdict result — the actual gate effect)");
}

function checkGate(art, errs) {
  const { input: inp, output: out } = art;
  // The gate decides per ITEM (whole panel); no sub-instance is required.
  if (!isObj(inp)) { errs.push("input: required object for gate"); }
  else if (!Array.isArray(inp.lenses) || inp.lenses.length === 0) {
    errs.push("input.lenses: non-empty array of per-lens kept-finding sets");
  } else {
    inp.lenses.forEach((l, i) => {
      if (!isNonEmptyString(l?.lens_id)) errs.push(`input.lenses[${i}].lens_id: required`);
      if (typeof l?.blocking !== "boolean") errs.push(`input.lenses[${i}].blocking: boolean`);
      if (typeof l?.applicable !== "boolean") errs.push(`input.lenses[${i}].applicable: boolean`);
      if (!Array.isArray(l?.kept) || !l.kept.every(isFinding)) errs.push(`input.lenses[${i}].kept: array of findings`);
      if (l?.infra_error != null && !isNonEmptyString(l.infra_error)) errs.push(`input.lenses[${i}].infra_error: string or null`);
    });
  }

  if (!isObj(out)) { errs.push("output: required object for gate"); }
  else {
    if (!GATE_VERDICTS.includes(out.verdict)) errs.push(`output.verdict: one of ${GATE_VERDICTS.join("|")}`);
    if (!Array.isArray(out.per_lens)) errs.push("output.per_lens: array of {lens_id, conclusion}");
    else out.per_lens.forEach((l, i) => {
      if (!isNonEmptyString(l?.lens_id)) errs.push(`output.per_lens[${i}].lens_id: required`);
      if (!LENS_CONCLUSIONS.includes(l?.conclusion)) errs.push(`output.per_lens[${i}].conclusion: one of ${LENS_CONCLUSIONS.join("|")}`);
    });
  }
}

const STAGE_CHECKERS = { detection: checkDetection, verifier: checkVerifier, gate: checkGate };

// --- public API --------------------------------------------------------------

/**
 * Validate a stage artifact against the v1 contract. Returns
 * `{ valid, errors }` — `errors` is a list of "path: message" strings (empty iff
 * valid). Collects ALL problems rather than throwing on the first, so a fixture
 * extractor can report everything wrong with a record at once.
 */
export function validateStageArtifact(art) {
  const errs = [];
  if (!isObj(art)) return { valid: false, errors: ["artifact: must be an object"] };

  if (art.schema_version !== STAGE_ARTIFACT_VERSION) {
    errs.push(`schema_version: expected "${STAGE_ARTIFACT_VERSION}" (got ${JSON.stringify(art.schema_version)})`);
  }
  if (!isNonEmptyString(art.item_id)) errs.push("item_id: required non-empty string");
  if (!isObj(art.instance)) errs.push("instance: required object");
  checkProvenance(art.provenance, errs);

  if (RESERVED_STAGES.includes(art.stage)) {
    errs.push(`stage: "${art.stage}" is RESERVED — the pipeline does not emit it yet; update STAGES + a checker when it lands`);
  } else if (!STAGES.includes(art.stage)) {
    errs.push(`stage: one of ${STAGES.join("|")} (got ${JSON.stringify(art.stage)})`);
  } else if (isObj(art.instance)) {
    // Only run the per-stage shape check once the envelope essentials are objects.
    STAGE_CHECKERS[art.stage](art, errs);
  }

  return { valid: errs.length === 0, errors: errs };
}

/** Throwing wrapper for call sites that want fail-fast (extractor, tests). */
export function assertStageArtifact(art) {
  const { valid, errors } = validateStageArtifact(art);
  if (!valid) throw new Error(`invalid stage artifact:\n  - ${errors.join("\n  - ")}`);
  return art;
}

/**
 * Stable store key for a stage artifact — the `item × stage × instance` address
 * task 3's fixture corpus is keyed by. Deterministic and collision-free across
 * the three stages: detection→`item::detection::lens`, verifier→
 * `item::verifier::lens::population::finding_key`, gate→`item::gate`.
 */
export function stageInstanceKey(art) {
  const { item_id: item, stage, instance: ins = {} } = art;
  if (stage === "detection") return `${item}::detection::${ins.lens_id}`;
  if (stage === "verifier") return `${item}::verifier::${ins.lens_id}::${ins.population}::${ins.finding_key}`;
  if (stage === "gate") return `${item}::gate`;
  return `${item}::${stage}`;
}

/** The dedupe/identity key review-panel uses everywhere (dedupeFindings,
 * compareSampleAgreement): `${file}::${lowercased-trimmed summary}`. Exported so
 * the extractor stamps `instance.finding_key` with the SAME key the pipeline uses
 * internally — a verifier fixture is then addressable by the finding it verified. */
export function findingKey(f) {
  return `${f?.file ?? ""}::${String(f?.summary ?? "").toLowerCase().trim()}`;
}
