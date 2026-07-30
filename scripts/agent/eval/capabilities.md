# What the eval harness can answer today

A plain-language index of every question this harness can currently answer, what it
costs, and how to run it. For the architecture and the artifact contract, see
[`README.md`](README.md) and [`stage-artifacts.md`](stage-artifacts.md); this page is
the map, not the territory.

**The one-line version:** the review panel is a non-deterministic judge, and this
harness re-runs it against frozen historical PRs so we can measure whether it is
*stable* (same answer twice), whether it is *right* (agrees with a human label), and
whether each part of it is *worth its cost*.

---

## Pick a question

| You want to know… | Mode | Costs model budget? |
|---|---|---|
| Does the panel reach the same **block/approve verdict** when re-run? | `reliability` | **Yes** — K full panel runs |
| **Which stage** is the noisy one (gate, verifier, detection)? | `stage-pilot` | **Yes** — 1 capture + cheap replays |
| Is the **second detection sample** earning its cost? | `stage-pilot` + `stage_detection_only` | **Yes** — 1 capture + K detection replays |
| Does the **verifier** keep real bugs and drop hallucinations? | `validity` | **No** — $0, re-scores existing data |

All four run from the same workflow: **Actions → `agent-eval` → Run workflow**, picking
the `mode` input. Every dispatch is manual on purpose, because three of the four spend
real money.

---

## The four capabilities

### 1. Whole-panel reliability — "is the verdict stable?"

Runs the entire panel over the corpus K times and asks how often the block/approve
verdict changes between identical runs. Reports a **flip rate** and **Fleiss κ**
(agreement corrected for what you'd get by chance).

This is the broadest signal and the most expensive one. It tells you *that* the panel
is unstable without telling you *where* the instability comes from.

> κ is computed only on the binary verdict, never on raw finding sets — for open-ended
> detection the "negative class" is unbounded, which makes κ mis-specified. Finding-level
> agreement uses positive overlap instead.

### 2. Stage isolation — "which stage is noisy?"

Captures **one** item with a single real panel run, freezes each stage's exact inputs,
then replays individual stages K times. Because only the capture is panel-scale, this
is far cheaper than K whole-panel runs, and it attributes noise to a specific stage.

- **gate** — pure logic, free, deterministic
- **verifier** — cheap per finding, capped by `stage_max_verifier`
- **detection** — the expensive one; re-runs every lens, opt-in

This mode exists because the PR #521 flip turned out to be a *verifier* event, which a
whole-panel pass cannot see.

### 3. Sample-count study — "is the 2nd detection sample worth it?" *(new)*

Every lens currently runs **twice** and the results are merged, as insurance against a
single run missing a bug. That insurance is the single largest cost in the pipeline.

This study reuses the detection replays as raw material. Each replay at `samples: 2`
produces **two independent single-sample draws**, so K replays give **2K draws**. From
those it works out how much you'd have caught with 1 sample, 2, 3, and so on — without
re-running anything.

The number that decides it is **`marginal_second_sample`** = recall(2) − recall(1). Near
zero means the second sample is buying nothing.

Two deliberate choices worth knowing:

- **Exact, not simulated.** For a defect appearing in *m* of *D* draws, the chance a
  random *N*-subset contains it is `1 − C(D−m,N)/C(D,N)`. The curve is computed from
  that formula, so there is no randomness and no run-to-run wobble.
- **Semantic matching.** Two runs describing one bug in different words must count as
  one finding. The scorer uses `findingSimilarity` (word-overlap ≥ 0.3), *not* the exact
  `file::summary` string key used elsewhere — see the caveat table below.

### 4. Verifier validity — "is the verifier right?" *(Track B, $0)*

Everything above measures *consistency*. This measures *correctness*, by joining each
verifier decision to a human-committed label and building a confusion matrix:

|  | verifier **keeps** | verifier **drops** |
|---|---|---|
| **real defect** | good | **killed a real bug** (the #521 cell) |
| **hallucination** | junk reaches the gate | good |

It re-scores data a previous `stage-pilot` already produced, so a dispatch costs a
runner-minute and zero model budget. It needs labels committed under
`labels/<corpus_version>/findings/` in the results repo — **that tree is the dataset**;
you grow it by committing more labels.

---

## Running each one

Dispatch **Actions → `agent-eval` → Run workflow** and set `mode`. Non-obvious inputs
only; everything else can stay at its default.

| Mode | Key inputs | Notes |
|---|---|---|
| `reliability` | `runs: 3+` | κ needs ≥2. Cost scales with K × corpus size |
| `stage-pilot` | `stage_pr`, `stage_k: 2+` | Defaults to gate+verifier (cheap) |
| `stage-pilot` (sample-count) | `stage_detection_only: true`, `stage_k: 3+` | Detection only; skips gate+verifier |
| `validity` | `corpus_version` matching a prior stage-pilot | Free; needs labels committed |

**For the sample-count study specifically:**

```
mode:                  stage-pilot
stage_pr:              521          (or any PR that raises a blocking finding)
stage_k:               3            → 3 replays × samples:2 = 6 draws per lens
stage_detection_only:  true         → skips gate + verifier entirely
corpus_version:        <a NEW value>
```

Use a **fresh `corpus_version`** each time. Captures are namespaced by it, and reusing a
value makes the run resume against the old capture instead of taking a new one.

Results land in the `wafflebase-agent-eval` results repo under
`stage-fixtures/<corpus_version>__stagepilot/scores/`, and always as a downloadable CI
artifact as a backup.

Local equivalents for every mode are in [`README.md`](README.md).

---

## Module inventory

| File | Role | Model calls? |
|---|---|---|
| `config-hash.mjs` | judge identity (`config_hash`), rubric content hash | no |
| `config-build.mjs` | lenses dir ↔ config manifest + reproduction snapshot | no |
| `store.mjs` | `GitFsStore` — artifacts, fixtures, and labels in the results repo | no |
| `extract-corpus.mjs` | freeze historical PR diffs → corpus items | no (uses `gh`) |
| `adapters/reviewer.mjs` | runs `review-panel.mjs` for one item | **yes** |
| `run.mjs` | the runner — loops the corpus, resumable | **yes** |
| `reliability.mjs` | whole-panel verdict stability + Fleiss κ | no |
| `stage-artifacts.mjs` | the `stage-artifacts/v1` schema + validator | no |
| `stage-capture.mjs` | captured panel run → per-stage artifacts | no |
| `extract-stage-fixtures.mjs` | harvest a capture into a fixture corpus | no |
| `stage-adapters.mjs` | per-stage replay adapters | detection/verifier **yes** |
| `stage-run.mjs` | replay one stage K times | via adapter |
| `stage-reliability.mjs` | per-stage flip-rate / κ / overlap | no |
| `sample-count-analysis.mjs` | the 1-vs-2 sample study | no |
| `verifier-validity.mjs` | verifier confusion matrix vs labels | no |

Every pure module is unit-tested: `node --test scripts/agent/eval/*.test.mjs`.

---

## Known limits — read before quoting a number

| Limit | What it means in practice |
|---|---|
| **The corpus is unlabeled** (except what Track B has labeled) | "Recall" in the sample-count study is measured against the union of the runs themselves, not ground truth. It means *"coverage versus what the panel can find across repeated tries"* — not *"versus every real bug"*. |
| **The self-consistency oracle pins the curve** | Because the oracle is the union of all D draws, recall at N=D is 1.0 **by construction**. The right-hand end of the curve is an artefact; only the low-N end, and `marginal_second_sample`, are interpretable. Do not read a rising tail as "more samples would help". |
| **`stage-reliability`'s detection overlap reads low** | It keys findings on an exact `file::lowercased-summary` string, so one defect reworded counts as two disjoint findings. Its detection `mean_jaccard` is a lower bound. `sample-count-analysis.mjs` matches semantically and is the one to trust on detection agreement. (`compareSampleAgreement` in the panel has the same flaw, for the same reason.) |
| **stage-pilot captures ONE item** | `stage_pr` takes a single PR. Broader coverage means several dispatches with different `corpus_version` values. |
| **Diff-only replay degrades the verifier** | The verifier greps the repo tree, so it needs repo context. Keep `no_repo_context: false` unless you are deliberately studying detection alone. A silent diff-only capture over-flags and explodes verifier fan-out — this is what billed $44 on the #521 pilot. |
| **The branch panel is what gets measured** | The harness runs `review-panel.mjs` *from this branch*. If the branch drifts behind `upstream/main`, every run measures a reviewer that is not what ships. Check before dispatching: `git diff --name-only HEAD upstream/main -- scripts/agent/ \| grep -v eval/` |
| **Single review pass** | No multi-round fix loop and no prior-findings recheck, so round-to-round behaviour is out of scope. |

---

## Glossary

- **Lens** — one reviewer with one rubric (correctness, security, design-fit,
  test-adequacy, blast-radius, docs).
- **Sample** — one run of one lens. The panel currently takes two and merges them.
- **Draw** — one sample's findings, treated as an independent observation by the
  sample-count study.
- **Gate** — the final block/approve decision.
- **Blocking finding** — severity `critical` or `major`. `minor` and `nit` never block.
- **Fixture** — one stage's frozen inputs, so that stage can be replayed alone.
- **Flip rate** — how often repeated identical runs disagree.
- **κ (Fleiss' kappa)** — agreement corrected for chance. 1.0 = perfect, 0 = no better
  than guessing.
- **Corpus version** — the label that namespaces a frozen set of PR diffs and
  everything derived from it.
