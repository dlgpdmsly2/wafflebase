# Stage-artifact contract (`stage-artifacts/v1`)

*The frozen-input / observed-output record for one review-panel **stage**, and the
prerequisite contract for Mode A — stage-isolated reliability. Validator:
[`stage-artifacts.mjs`](stage-artifacts.mjs). Companion design analysis:
`whole-process-reliability-design.md`; task list: `mode-a-task-list.md`.*

> **Grounded in `review-panel.mjs` as of upstream/main** (through #573 independent
> verifier, #574 coverage-first rubrics, #576 blast-radius lens, #578 SDK-wrapper
> extraction). The eval-harness branch that carries this file is *behind* those on
> the pipeline; the shapes below track the pipeline that will actually be
> instrumented in task 2, so the branch must be rebased onto that pipeline before
> the emitter lands. The `eval/` directory itself is unchanged upstream, so the
> rebase touches only the pipeline, not this harness.

## 1. Why this exists

The current reliability scorer ([`reliability.mjs`](reliability.mjs)) measures one
thing: does the **whole panel**, re-run on a frozen diff K times, reach the same
**gate verdict**? That is a *component* measurement of a pipeline that is now
multi-stage. Mode A instead freezes the input to **one stage**, replays only that
stage K times, and measures *that stage's* decision stability — cheaper, and
attributable (you learn *which* stage is noisy). The motivating failure (PR #521,
a finding cleared on unchanged code and re-raised) is a *verifier* flip, invisible
to a whole-panel pass.

To replay a stage in isolation you need its input **frozen** and its output
**recorded**. A *stage artifact* is exactly that record, captured during a normal
run (task 2) and harvested into a fixture corpus keyed by `item × stage × instance`
(task 3). This document is the shape; the validator enforces it.

## 2. The real stage topology (three stages, not five)

The early design sketch enumerated five stages (detection / verifier / rebuttal /
adjudicator / gate). Reading the shipped [`review-panel.mjs`](../review-panel.mjs)
corrects this: the pipeline emits **three** decision points.

| Stage | Source (review-panel.mjs) | Frozen input | Recorded output | Model calls | Replay determinism |
|---|---|---|---|---|---|
| `detection` | `runLens` × `samples`, then `unionSamples` / `compareSampleAgreement` | rubric + diff + issue + repo commit + N | union findings, per-sample findings, agreement | N per lens (panel-scale) | stochastic — the reliability question |
| `verifier` | `verifyFinding` → `applyVerifications` / `isDroppingVerdict` | one frozen finding + rubric + **repo** + changed-file trust context | confirm/refute + confidence + ground + citations + `dropped` | 1 per blocking finding (cheap, ≤8 turns) | stochastic — **the #521 mechanism** |
| `gate` | `severity.classify` + the `panel[]` rollup | the per-lens kept-finding sets | block/approve + per-lens conclusion | none | **pure** → a unit assertion, not a paid target |

Three deliberate consequences:

- **The cross-round re-check is not a separate stage.** review-panel's "Part 2"
  re-runs the *same* `verifyFinding` / `applyVerifications` primitive over the
  previous round's findings. Same call shape ⇒ same replay adapter ⇒ **one**
  `verifier` stage, discriminated by `instance.population` (`fresh` vs
  `prior-round`), not two stages.
- **The verifier is independent (#573) — it is *not* given the diff.** The lens
  that raised a finding reasoned from the diff; a verifier reading that same diff
  inherits its blind spots (the correlated-error failure of naive panels). So
  `verifyFinding` re-establishes the facts from the repository itself (`Read`/
  `Grep`/`Glob`, `cwd = repo`). Two things follow for this contract: `repo_commit`
  is **load-bearing** for the verifier, and the verifier `input` carries **no
  diff** — the validator rejects one that does (a fixture with a verifier diff is
  from the pre-#573 pipeline).
- **`rebuttal` and `adjudicator` are reserved, not emitted.** They appear in the
  design doc as where the pipeline *may* go; no code (local or upstream) produces
  them. They are listed in `RESERVED_STAGES` and the validator **rejects** them, so
  a fixture from an unrecognized future pipeline fails loudly instead of validating
  by accident. When such a stage lands, add it to `STAGES` with its own checker.

## 3. The envelope

Every artifact, regardless of stage, is one JSON object:

```jsonc
{
  "schema_version": "stage-artifacts/v1",
  "item_id": "pr-521",                 // corpus item this was captured from
  "stage": "detection|verifier|gate",
  "instance": { /* stage-specific addressing — see §5 */ },
  "provenance": {
    "run_id": "2026-07-29T…__baseline-opus-s2",
    "config_hash": "sha256:74703c…",   // judge identity (config-hash.mjs)
    "sdk_version": "0.3.217",
    "model": "claude-opus-5",          // optional; the model the stage used
    "captured_at": "2026-07-29T12:34:56.000Z"
  },
  "input":  { /* stage-specific FROZEN input — replay against this */ },
  "output": { /* stage-specific OBSERVED decision — measure reliability on this */ }
}
```

`input` is everything needed to re-invoke the stage **without re-running any
upstream stage** — that independence is what makes stage-isolation work. `output`
is the decision the capture run produced (the K=1 datum; K≥2 replays add rows).

### BlobRef — large, shared inputs are referenced, not inlined

The diff, rubric, issue spec, and changed-files list are identical across all of an
item's stage records, so they are **content-addressed** into the fixture store and
referenced:

```jsonc
{ "sha256": "sha256:<64 hex>", "bytes": 40213 }
```

Small values (a single finding, a kept-set, the trust summary) are inlined. Repo
context is neither — it is a **git commit** (`materializeRepoAt` checks out the tree
at `review_commit`), carried as `repo_commit: "<oid>" | null`.

### Finding

Recorded **as produced** — mirroring review-panel's `FINDING` schema. `severity` and
`summary` are required; `confidence` (`high|medium|low`, the #573 axis), `file`, and
`evidence` are optional (a script-synthesised fail finding carries no `confidence`,
so the field cannot be required here). `severity` accepts any string on purpose: the
gate normalizes unknown → `major` downstream, and a fixture must preserve what the
model actually emitted, not a normalized copy.

```jsonc
{ "severity": "major", "confidence": "high", "file": "packages/x/y.ts", "summary": "…", "evidence": "…" }
```

## 4. Per-stage `input` / `output`

### `detection`
```jsonc
"input": {
  "rubric": <BlobRef>, "diff": <BlobRef>,
  "issue": <BlobRef|null>, "changed_files": <BlobRef|null>,
  "repo_commit": "<oid>|null", "samples": 2
},
"output": {
  "union": [<Finding>…],            // unionSamples() — coerced + deduped, kept-highest-severity
  "per_sample": [[<Finding>…], …],  // one raw findings array per SUCCESSFUL sample
  "samples_run": 2, "samples_ok": 2,
  "agreement": "identical",         // compareSampleAgreement: single|identical|partial|disjoint
  "severity_counts":   { "critical": 0, "major": 1, "minor": 0, "nit": 0 },
  "confidence_counts": { "high": 1, "medium": 0, "low": 0, "unknown": 0 }
}
```
Reliability metric (task "metrics"): positive **overlap / Jaccard** on the union
finding-set across replicates — κ is mis-specified for open-ended detection (the
negative class is unbounded), as [`reliability.mjs`](reliability.mjs) already notes.

### `verifier` (both `fresh` and `prior-round`)
```jsonc
"input": {
  "finding": <Finding>,             // the frozen finding under test
  "rubric": <BlobRef>,
  "changed_files": <BlobRef|null>,  // source of the trust context (200-file cap applied downstream)
  "changed_context": { "authoritative": true, "total": 12, "listed_count": 12 },
  "repo_commit": "<oid>|null",      // LOAD-BEARING: the working tree the verifier Greps
  "model": "claude-opus-5",
  "max_turns": 8                    // VERIFIER_MAX_TURNS
  // NOTE: no `diff` — the independent verifier is deliberately not given it.
},
"output": {
  "decision": {                     // field names AS PRODUCED (camelCase) by VERIFIER_SCHEMA
    "verdict": "refuted",           // confirmed | refuted
    "confidence": "high",           // high | low
    "reason": "…",
    "refutationGround": "already-guarded", // not-present|already-guarded|out-of-scope|pre-existing|none
    "groundedIn": ["packages/x/y.ts:42"]   // file:line citations it actually read
  },
  "error": null,                    // XOR with decision: a verifier error KEEPS the finding
  "dropped": true                   // isDroppingVerdict(decision, {allowPreExisting}) — the actual gate effect
}
```
Exactly one of `decision` / `error` is set. `dropped` records the true consequence:
`isDroppingVerdict` drops only on `refuted` + `high` + a valid non-`none`
`refutationGround` + a `file:line` in `groundedIn`, and `pre-existing` is honoured
only when `changed_context.authoritative` (`allowPreExisting`). Reliability metric:
**binary flip-rate + Fleiss κ** on `verdict` (or on `dropped`) across replicates.

> **Fidelity interaction.** The reviewer adapter's v1 replay is *diff-only*
> (`repo_commit → null`). A diff-only verifier replay **starves** the #573
> verifier of the repository it must Grep, so it is low-fidelity for this stage.
> The validator permits `repo_commit: null` (it does not fail a fixture) but flags
> the consequence; a faithful verifier-stage pilot needs repo context materialized.

### `gate` (pure — a unit assertion, not a paid target)
```jsonc
"input": {
  "lenses": [
    { "lens_id": "correctness", "blocking": true, "applicable": true,
      "kept": [<Finding>…], "infra_error": null },
    …                               // one per manifest lens (5: +blast-radius)
  ]
},
"output": {
  "per_lens": [ { "lens_id": "correctness", "conclusion": "failure" }, … ],
  "verdict": "block"                // block iff any applicable blocking lens keeps a critical/major
}
```
Because the gate is a pure function of its input, its "replay" is
`assert gate(input) === output` — determinism, not variance. Capturing it still
matters: it is the substrate for the **label-free stage ablation** (compare the
gate verdict's flip-rate *with* vs *without* an upstream stage).

## 5. Addressing — `instance` and the store key

The fixture corpus is keyed by `item × stage × instance`. `instance` carries only
what a stage needs to be uniquely addressed:

| Stage | `instance` | `stageInstanceKey(art)` |
|---|---|---|
| `detection` | `{ lens_id }` | `pr-521::detection::correctness` |
| `verifier` | `{ lens_id, population, finding_key }` | `pr-521::verifier::correctness::fresh::<key>` |
| `gate` | `{}` (per-item, whole panel) | `pr-521::gate` |

`finding_key` is stamped with `findingKey(f)` = `` `${file}::${lowercased-trimmed
summary}` `` — the **same** identity key review-panel uses in `dedupeFindings` /
`compareSampleAgreement`, so a verifier fixture is addressable by the finding it
verified, stably across replicate runs.

## 6. Using the validator

```js
import { validateStageArtifact, assertStageArtifact, stageInstanceKey, findingKey } from "./stage-artifacts.mjs";

const { valid, errors } = validateStageArtifact(art); // collects ALL problems
assertStageArtifact(art);                              // or throw on the first invalid record
const key = stageInstanceKey(art);                     // store address
```

The validator is **pure** (no fs/SDK/clock) and **strict**: where the review logic
fails toward *blocking*, a validator fails toward *rejection* — its job is to stop a
malformed fixture before it poisons a replay. It reports every problem as a
`"path: message"` string rather than throwing on the first.

## 7. Emission & forward references

- **Emission — DONE (task 2), as a two-part split, not a single writer.** The panel
  cannot emit a *complete* artifact: it does not know its `run_id` / `config_hash` /
  `item_id` (those are harness concepts, and it also runs in the real issue→PR
  workflow). So:
  - **`review-panel.mjs`** writes only the raw per-instance DETAIL it uniquely holds
    and used to discard — each lens's `stage-detail.json` = `{ samples: [[Finding…]…],
    verifications: [{ population, finding, verdict, dropped }…] }` — dependency-free,
    in the same style as the diagnostic files it already writes. The reviewer adapter
    surfaces it as `payload.stageDetail`.
  - **`stage-capture.mjs`** (`buildStageArtifacts(captured, ctx)`) projects that detail
    into these validated artifacts, stamping provenance/`item_id`/input BlobRefs, and
    **reusing the panel's own exported helpers** (`unionSamples`,
    `compareSampleAgreement`, `changedFileContext`, `VERIFIER_MAX_TURNS`) so the union,
    agreement label, and trust context are computed by the exact code that ran — no
    re-derivation that could drift. It `assertStageArtifact`s every record.
- **Fixture store (task 3).** Wire `buildStageArtifacts` into `run.mjs` at capture
  time and harvest the results into `stage-fixtures/<version>`, keyed by
  `stageInstanceKey`, deduping BlobRef blobs by `sha256`.
- **Fixture store (task 3).** The extractor harvests each stage's frozen input into
  `stage-fixtures/<version>`, keyed by `stageInstanceKey`, deduping BlobRef blobs by
  `sha256`.
- **Stage-level adapter (task 4).** The Target Adapter seam generalizes so a
  *stage* is a target; `prepareInput` loads a frozen upstream artifact (this shape)
  instead of the raw diff — and, for the verifier, must materialize `repo_commit`
  (see the fidelity note in §4).
