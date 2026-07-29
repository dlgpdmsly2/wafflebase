# Offline replay eval harness (`scripts/agent/eval`)

Reproducible offline evaluation of the agent pipeline. Replays a **frozen corpus
of historical diffs** through a review configuration and measures **cross-run
reliability** (does the same diff, re-run under the same judge, reach the same
gate verdict?). Data + artifacts live in a **separate results repo**
(`wafflebase-agent-eval`), reached through an `ArtifactStore` so the location is
a config value, not a dependency.

Built behind a **Target Adapter seam**: the framework runner is role-agnostic;
the review panel is one adapter. A code-fixer or end-to-end target is a new
adapter, not a harness rewrite.

## Modules

| File | Role | Model calls? |
|---|---|---|
| `config-hash.mjs` | judge identity (`config_hash`), rubric content hash | no |
| `config-build.mjs` | lenses dir → config manifest + reproduction snapshot; materialize back | no |
| `store.mjs` | `GitFsStore` — the `ArtifactStore` over the results repo | no |
| `extract-corpus.mjs` | freeze historical PR diffs → corpus items + manifest | no (uses `gh`) |
| `adapters/reviewer.mjs` | ReviewerAdapter: prepareInput / runAgent / captureArtifacts | **yes** (spawns `review-panel.mjs`) |
| `run.mjs` | framework runner — loops corpus, writes immutable artifacts, resumable | **yes** |
| `reliability.mjs` | cross-run scorer — verdict stability + Fleiss κ over replicate runs | no |

All pure logic is unit-tested (`node --test *.test.mjs`). Identity/versioning,
artifact shapes, and invariants: see the results repo README + the schema doc.

## Metric note

κ is computed **only on the binary gate verdict** (block/approve) — a fixed set
of items × K replicate runs, where chance-corrected agreement is well-defined. κ
is deliberately **not** computed over raw finding sets (open-ended detection → the
negative class is unbounded → κ is mis-specified; use positive overlap there).

## Runbook — the first replicated run (INVOKES THE MODEL — costs money)

Cost per run ≈ (lenses × samples × (+verifier)) × items Opus calls. Start small.

```bash
# 0. one-time: install the SDK the panel imports
cd scripts/agent && npm ci                    # (or: corepack pnpm install)

# Auth: the panel's SDK reads CLAUDE_CODE_OAUTH_TOKEN. `claude setup-token` is
# INTERACTIVE (opens a browser, prints a banner) — do NOT wrap it in $(...), that
# captures the banner as the token and every call fails with an invalid
# Authorization header. Run it alone, copy the printed sk-ant-oat01-… token, then:
export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-…'   # paste the token, quoted
# sanity check — must print ONLY the token prefix, not a banner:
printf '%s\n' "${CLAUDE_CODE_OAUTH_TOKEN:0:14}"    # → sk-ant-oat01-

EVAL=../../..//wafflebase-agent-eval          # path to the results repo checkout
V=2026-07-28-pilot

# 1. freeze a corpus (no model calls)
node eval/extract-corpus.mjs --out "$EVAL" --corpus-version "$V" --limit 20

# 2. run K=3 replicates of the baseline judge (resumable: re-run same --run-id)
for i in 1 2 3; do node eval/run.mjs --out "$EVAL" --corpus-version "$V" --config-id baseline-opus-s2; done

# 3. score cross-run reliability (config_hash is printed by run.mjs / config-build.mjs)
node eval/reliability.mjs --out "$EVAL" --config-hash sha256:<hash> --corpus-version "$V"

# 4. commit the results repo (artifacts are the point of that repo)
git -C "$EVAL" add -A && git -C "$EVAL" commit -m "pilot runs + reliability score"
```

## Mode A — stage-isolated reliability

The whole-panel scorer above measures one thing: does the panel, re-run on a frozen
diff, reach the same **gate verdict**? Mode A instead freezes the input to **one
stage** and replays just that stage K times, so you learn *which* stage is noisy —
cheaper and attributable (the motivating PR #521 flip is a *verifier* event,
invisible to a whole-panel pass). Full contract: [`stage-artifacts.md`](stage-artifacts.md).

| File | Role | Model calls? |
|---|---|---|
| `stage-artifacts.mjs` | the `stage-artifacts/v1` schema + a strict validator | no |
| `stage-capture.mjs` | project a captured panel run → validated detection/verifier/gate artifacts | no |
| `extract-stage-fixtures.mjs` | harvest a captured run's fixtures → `stage-fixtures/<v>` corpus (offline) | no |
| `stage-adapters.mjs` | per-stage adapters (gate=pure; detection/verifier reuse `runLens`/`verifyFinding`) | detection/verifier **yes** |
| `stage-run.mjs` | replay one stage over its fixtures under a run_id (K = K run_ids) | via adapter |
| `stage-reliability.mjs` | per-stage flip-rate + Fleiss κ (gate/verifier); overlap (detection) | no |

Runbook — one item, K=2 (only the capture is panel-scale):

```bash
V=2026-07-28-pilot; SV="${V}__stagepilot"; PR=521
# 1. capture ONE item (a real panel run → per-stage detail in the payload)
node eval/run.mjs --out "$EVAL" --corpus-version "$V" --items "pr-$PR" --run-id stage-capture
# 2. harvest frozen fixtures (offline, free)
node eval/extract-stage-fixtures.mjs --out "$EVAL" --run-id stage-capture --stage-version "$SV"
# 3. replay each stage K=2 times (verifier/detection need repo context: --repo-source)
for k in 1 2; do for s in gate verifier detection; do
  node eval/stage-run.mjs --out "$EVAL" --stage-version "$SV" --stage "$s" --run-id "$s-$k" --repo-source ../../..
done; done
# 4. per-stage reliability vector
for s in gate verifier detection; do node eval/stage-reliability.mjs --out "$EVAL" --stage-version "$SV" --stage "$s"; done
```

On CI: dispatch `agent-eval` with **`mode: stage-pilot`** (inputs `stage_pr`, `stage_k`).

## Fidelity to production

The harness invokes the **exact** `review-panel.mjs` orchestrator (not a
reimplementation) with the live `lenses.json` + rubric prompts + models, so the
reviewer's *judgment* is faithful. Two context upgrades bring the *input* closer
to what the panel saw in production:

- **(a) Repo context** — the runner checks out the repo TREE at each item's
  `review_commit` (`git archive`, cached per commit) and passes it as `--repo`, so
  lenses `Read`/`Grep` real surrounding code (not an empty dir). Disable with
  `--no-repo-context` for diff-only replay.
- **(b) Review-point diff** — `extract-corpus --review-point` freezes the diff at
  the commit the panel actually reviewed, not the merged state. Modes:
  **`pr-open`** (default) — the diff as the PR was *opened for review* (every commit
  before `createdAt`; agents → their implement commit, humans → what they pushed
  before opening, no partial-WIP risk); **`first`** — the literal first commit;
  **`head`** — the merged state; **`auto`** — agent→first / human→head (legacy).
  Recorded per item as `review_commit`/`review_point`.

Remaining divergences (documented, not yet closed): single review pass (no
multi-round fix loop / prior-findings recheck), no GitHub workflow orchestration,
and `additions`/`deletions`/`scope` reflect the merged PR (a size proxy) rather
than the review-point diff. The repo checkout requires the PR commits fetched into
`--repo-source` (the extractor fetches `refs/pull/N/head`); if a commit is
unavailable the runner falls back to diff-only for that item.
