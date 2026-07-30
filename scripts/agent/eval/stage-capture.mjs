// stage-capture — project a captured review-panel run into validated stage
// artifacts (Mode A). The panel emits raw per-instance DETAIL it uniquely holds
// (per-sample findings + per-finding verifier verdicts, in each lens's
// stage-detail.json, surfaced by the reviewer adapter as payload.stageDetail);
// this module WRAPS that detail with the harness-only facts the panel cannot know
// (item_id, provenance, input BlobRefs, repo_commit) and shapes it to
// stage-artifacts/v1, asserting every record before returning it.
//
// Layering: the harness depends on the pipeline, never the reverse. The panel's
// own helpers (unionSamples / compareSampleAgreement / changedFileContext /
// VERIFIER_MAX_TURNS) are imported and REUSED so the union, agreement label, and
// changed-file trust context are computed by the exact code that ran in
// production — no re-derivation that could drift from the panel.
//
// Pure: no fs / SDK / clock. The caller passes BlobRefs it already computed and a
// `captured_at` timestamp it already stamped; this module only reshapes + validates.

import {
  unionSamples, compareSampleAgreement, severityCounts, confidenceCounts,
  changedFileContext, VERIFIER_MAX_TURNS,
} from "../review-panel.mjs";
import { STAGE_ARTIFACT_VERSION, findingKey, assertStageArtifact } from "./stage-artifacts.mjs";

/**
 * @param captured  the reviewer adapter payload: { panel, lensStats, findings, stageDetail }
 * @param ctx       harness-only facts the panel cannot know:
 *   {
 *     item_id,
 *     provenance: { run_id, config_hash, sdk_version, captured_at },
 *     repo_commit,            // string | null (the tree the verifier Grepped; null = diff-only)
 *     changed_files,          // string[] fed to the panel (for changedFileContext)
 *     refs: { diff, issue, changed_files, rubricByLens: { [lensId]: BlobRef } },  // BlobRefs
 *     lensMeta: { [lensId]: { model, samples } },  // from the frozen config snapshot
 *   }
 * @returns the flat array of validated stage artifacts (detection + verifier + one gate).
 */
export function buildStageArtifacts(captured, ctx) {
  const panel = Array.isArray(captured?.panel) ? captured.panel : [];
  const stageDetail = captured?.stageDetail ?? {};
  const allFindings = Array.isArray(captured?.findings) ? captured.findings : [];
  const { item_id, provenance, repo_commit = null, refs = {}, lensMeta = {} } = ctx ?? {};
  const provBase = { ...provenance };
  // Reuse the panel's own trust computation — identical 200-cap + authoritative rule.
  const cc = changedFileContext(ctx?.changed_files ?? []);
  const changed_context = { authoritative: cc.authoritative, total: cc.total, listed_count: cc.listed.length };

  const artifacts = [];
  const base = (stage) => ({ schema_version: STAGE_ARTIFACT_VERSION, item_id, stage });

  for (const entry of panel) {
    const lens = entry.id;
    const detail = stageDetail[lens];
    if (!detail) continue; // skipped/failed lens — no sampling/verification ran
    const meta = lensMeta[lens] ?? {};
    const rubric = refs.rubricByLens?.[lens];
    const samples = Array.isArray(detail.samples) ? detail.samples : [];

    // --- detection ---
    const union = unionSamples(samples.map((findings) => ({ findings })));
    artifacts.push(assertStageArtifact({
      ...base("detection"),
      instance: { lens_id: lens },
      provenance: { ...provBase, model: meta.model },
      input: {
        rubric, diff: refs.diff, issue: refs.issue ?? null, changed_files: refs.changed_files ?? null,
        repo_commit, samples: meta.samples ?? samples.length,
        // lens replay params → self-contained runLens replay
        model: meta.model, title: meta.title, needs_issue_spec: !!meta.needsIssueSpec,
      },
      output: {
        union, per_sample: samples,
        samples_run: meta.samples ?? samples.length, samples_ok: samples.length,
        agreement: compareSampleAgreement(samples),
        severity_counts: severityCounts(union),
        confidence_counts: confidenceCounts(union),
      },
    }));

    // --- verifier (one per blocking finding, both populations) ---
    for (const v of Array.isArray(detail.verifications) ? detail.verifications : []) {
      const d = v.verdict; // raw verifier structured_output, or null (errored/no-output → finding kept)
      const decided = d && typeof d === "object" && typeof d.verdict === "string";
      artifacts.push(assertStageArtifact({
        ...base("verifier"),
        instance: { lens_id: lens, population: v.population, finding_key: findingKey(v.finding) },
        provenance: { ...provBase, model: meta.model },
        input: {
          finding: v.finding, rubric, changed_files: refs.changed_files ?? null,
          // VERIFIER_MAX_TURNS is now per claim-type ({presence, absence}); record the
          // presence budget as the informational max (verifyFinding derives its own on replay).
          changed_context, repo_commit, model: meta.model, max_turns: VERIFIER_MAX_TURNS.presence,
        },
        output: decided
          ? {
              decision: {
                verdict: d.verdict, confidence: d.confidence, reason: d.reason ?? "",
                refutationGround: d.refutationGround,
                groundedIn: Array.isArray(d.groundedIn) ? d.groundedIn : [],
              },
              error: null, dropped: !!v.dropped,
            }
          : {
              decision: null,
              error: { message: "verifier produced no verdict (errored or no structured output)", kind: "no-verdict" },
              dropped: !!v.dropped,
            },
      }));
    }
  }

  // --- gate (one per item; pure over the per-lens kept sets) ---
  const keptFor = (lensId) => allFindings
    .filter((f) => f.lens === lensId)
    .map((f) => ({ severity: f.severity, file: f.file, summary: f.summary, evidence: f.evidence }));
  artifacts.push(assertStageArtifact({
    ...base("gate"),
    instance: {},
    provenance: { ...provBase },
    input: {
      lenses: panel.map((p) => ({
        lens_id: p.id, blocking: !!p.blocking, applicable: !!p.applicable,
        kept: keptFor(p.id), infra_error: p.infraError ?? null,
      })),
    },
    output: {
      per_lens: panel.map((p) => ({ lens_id: p.id, conclusion: p.conclusion })),
      // block iff any APPLICABLE BLOCKING lens requested changes (mirrors mark-ready
      // / run.classifyItemOutcome — advisory + skipped + non-applicable never gate).
      verdict: panel.some((p) => p.applicable && p.blocking && p.conclusion === "failure") ? "block" : "approve",
    },
  }));

  return artifacts;
}
