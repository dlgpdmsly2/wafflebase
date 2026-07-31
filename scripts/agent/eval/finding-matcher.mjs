// finding-matcher — V2 of Track B. Decides whether two findings describe the SAME
// underlying defect, the join `finding_key` (exact `file::summary` equality) answers
// badly: exact-match misses reworded pairs (the pr-521 seed matched 0/6 captured
// findings), file-only co-location invents them (1 CodeRabbit comment → 40 panel
// findings on pr-549). See v2-matcher-design.md.
//
// This file starts with L1 — `extractAnchor` — the location signal a panel finding
// omits from its schema but leaks into its `summary`/`evidence` prose: backticked
// symbols, line hints, and file paths. Mined at SCORING time (pure, no run-layer
// change), it gives sub-file resolution — two findings in one file whose anchors
// name disjoint symbols are pushed apart — which is the fix for the file-only
// over-match. Coverage is expected to be partial (some evidence names no symbol);
// a finding with an empty anchor simply falls back to L0's file+token behaviour.
//
// The deterministic core is `matchFindings` → { verdict, score, method, reason }:
//   L0  reuse `findingSimilarity` (rounds.mjs) for the same-run raised↔raised case
//       it already handles, with its calibrated 0.3 overlap threshold;
//   L1  the anchor gate — same file but disjoint anchor symbols ⇒ demote, which is
//       what stops one comment matching every finding in a file (40→14 on pr-549);
//   L2  a SOFT location gate for cross-source pairs (label / CodeRabbit / human /
//       true-defect), where the absolute file gate is wrong: two reviewers can
//       blame different files for one defect. Never matches on tokens alone.
// L3 (LLM semantic adjudication of the residual `maybe`s) lands separately and is
// cost-gated. Ambiguity resolves to `maybe`, never `match`: a false match inflates
// precision, which is the more dangerous error (overview §5.4).

import { findingSimilarity, summaryTokens, DEFAULT_SIMILARITY } from "../rounds.mjs";

// Code-ish words that appear inside backticks but identify nothing.
const SYMBOL_STOP = new Set([
  "true", "false", "null", "undefined", "const", "let", "var", "function", "return",
  "this", "new", "await", "async", "void", "string", "number", "boolean", "any",
  "type", "class", "import", "export", "from", "the", "and", "not", "for",
]);

const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|mdx|html|yml|yaml";
const PATH_RE = new RegExp(`\\b[\\w./-]*[\\w-]+\\.(?:${CODE_EXT})\\b`, "g");
// `line 214`, `lines 626-640`, `lines ~626–640` (en/em dashes tolerated)
const LINES_RE = /\blines?\s*~?\s*(\d+)\s*(?:[-–—]\s*~?\s*(\d+))?/gi;
// a path/symbol suffixed with a line: `formula.ts:1054`, `foo.ts#L88`
const SUFFIX_LINE_RE = new RegExp(`(?:${CODE_EXT})[:#]L?(\\d+)\\b`, "gi");
// a backtick-quoted span (its inside is treated as code)
const BACKTICK_RE = /`([^`]+)`/g;
// an identifier that is being CALLED, in prose: `foo(` / `Foo.bar(`
const CALL_RE = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
// a bare identifier token (used only inside backticked code)
const IDENT_RE = /[A-Za-z_$][\w$]*/g;

const isSignalIdent = (s) => s.length >= 3 && !SYMBOL_STOP.has(s.toLowerCase()) && !/^\d/.test(s);

/**
 * Location anchor mined from a finding's `summary` + `evidence`:
 *   { symbols: string[], lines: [start,end][], files: string[] }
 * - symbols: identifiers from backticked code spans and prose call-sites
 *   (dotted chains kept whole AND split, so `Sheet.getUsedBounds` yields the chain
 *   plus `getUsedBounds`). Deduped case-insensitively, original casing preserved.
 * - lines: soft ranges; a single `line N` becomes [N,N]. Never compared for exact
 *   equality downstream — LLM line numbers drift; the matcher uses a window.
 * - files: paths named in the prose (BESIDES finding.file), the cross-source
 *   file-disagreement signal for L2.
 */
export function extractAnchor(finding) {
  const text = `${finding?.summary ?? ""}\n${finding?.evidence ?? ""}`;

  const symbols = new Map(); // lowercased → original (first seen)
  const addSym = (s) => { if (isSignalIdent(s)) { const k = s.toLowerCase(); if (!symbols.has(k)) symbols.set(k, s); } };

  // symbols from backticked code spans
  for (const m of text.matchAll(BACKTICK_RE)) {
    for (const id of m[1].matchAll(IDENT_RE)) addSym(id[0]);
  }
  // symbols from prose call-sites: keep the whole dotted chain and each segment
  for (const m of text.matchAll(CALL_RE)) {
    addSym(m[1]);
    if (m[1].includes(".")) for (const seg of m[1].split(".")) addSym(seg);
  }

  // line hints
  const lines = [];
  for (const m of text.matchAll(LINES_RE)) {
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    if (Number.isFinite(a)) lines.push([Math.min(a, b), Math.max(a, b)]);
  }
  for (const m of text.matchAll(SUFFIX_LINE_RE)) {
    const n = Number(m[1]); if (Number.isFinite(n)) lines.push([n, n]);
  }

  // file paths named in the prose (excluding the finding's own file)
  const own = String(finding?.file ?? "");
  const files = new Set();
  for (const m of text.matchAll(PATH_RE)) if (m[0] !== own) files.add(m[0]);

  return {
    symbols: [...symbols.values()],
    lines: dedupeRanges(lines),
    files: [...files],
  };
}

function dedupeRanges(ranges) {
  const seen = new Set();
  const out = [];
  for (const r of ranges) { const k = `${r[0]}:${r[1]}`; if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out;
}

/** True when the anchor carries no usable location signal → the matcher must fall
 *  back to L0 (file + token overlap) for this finding. */
export function anchorIsEmpty(anchor) {
  return !anchor || (anchor.symbols.length === 0 && anchor.lines.length === 0 && anchor.files.length === 0);
}

// --- anchor comparison ------------------------------------------------------

const lowerSet = (xs) => new Set((xs ?? []).map((s) => s.toLowerCase()));

export const LINE_WINDOW = 15;

/** Line ranges overlap within a tolerance window. LLM line numbers drift, so this
 *  is deliberately a window, never equality (design §3 L1). */
export function linesOverlap(a, b, window = LINE_WINDOW) {
  for (const [s1, e1] of a ?? []) {
    for (const [s2, e2] of b ?? []) {
      if (s1 - window <= e2 && s2 - window <= e1) return true;
    }
  }
  return false;
}

/**
 * How the two anchors relate: { sharedSymbols, symbolOverlap, lineHit, fileTie }.
 * `symbolOverlap` is a containment coefficient over symbols (same rationale as
 * findingSimilarity's overlap-over-Jaccard: one side often names far more symbols).
 */
export function compareAnchors(a, b) {
  const A = lowerSet(a?.symbols); const B = lowerSet(b?.symbols);
  let shared = 0;
  for (const s of A) if (B.has(s)) shared++;
  const denom = Math.min(A.size, B.size);
  return {
    sharedSymbols: shared,
    symbolOverlap: denom === 0 ? null : shared / denom, // null = one side named no symbol
    lineHit: linesOverlap(a?.lines, b?.lines),
    fileTie: null, // filled by the caller (needs the findings' own file fields)
  };
}

// --- the layered matcher ----------------------------------------------------

const trim = (s) => String(s ?? "").trim();
const res = (verdict, score, method, reason, extra = {}) => ({ verdict, score, method, reason, ...extra });

/** Do the two findings tie to a location at all? Exact same file = 1; a file named
 *  in the other's evidence = 0.6; symbols shared but no file tie = 0.3; else 0. */
function locationScore(a, b, anA, anB) {
  const fa = trim(a.file); const fb = trim(b.file);
  if (fa && fb && fa === fb) return 1;
  const namedByB = fa && (anB.files ?? []).some((f) => f === fa || fa.endsWith(`/${f}`) || f.endsWith(`/${fa}`));
  const namedByA = fb && (anA.files ?? []).some((f) => f === fb || fb.endsWith(`/${f}`) || f.endsWith(`/${fb}`));
  if (namedByA || namedByB) return 0.6;
  // basename agreement (packages/x/foo.ts vs foo.ts) — different depth, same file
  const base = (p) => p.split("/").pop();
  if (fa && fb && base(fa) === base(fb)) return 0.6;
  return 0;
}

/**
 * Decide whether two findings describe the same defect.
 *
 * `opts.crossSource` (default false) selects the gate: within one run both operands
 * are panel-shaped and the absolute file gate is right (L0/L1); across sources it is
 * wrong (L2 soft gate). `opts.threshold` overrides the token-overlap bar.
 *
 * Verdicts: `match` (confident), `maybe` (plausible → adjudication queue / L3),
 * `no`. Conservative by construction — ambiguity yields `maybe`.
 */
export function matchFindings(a, b, opts = {}) {
  if (!a || !b) return res("no", 0, "guard", "missing operand");
  const crossSource = opts.crossSource === true;
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY;

  const anA = extractAnchor(a);
  const anB = extractAnchor(b);
  const cmp = compareAnchors(anA, anB);

  // ---- same-run path: L0 similarity, then the L1 anchor gate ----------------
  if (!crossSource) {
    // The (lens, file) gate is checked HERE rather than inferred from a 0 score:
    // findingSimilarity returns 0 both for "gate failed" and for "same file but
    // under MIN_SHARED_TOKENS", and those must not be conflated — the latter is
    // inconclusive, and its anchors may still agree decisively.
    if (trim(a.lens) !== trim(b.lens) || trim(a.file) !== trim(b.file)) {
      return res("no", 0, "L0-similarity", "different lens or file (same-run gate)", { anchor: cmp });
    }
    const sim = findingSimilarity(a, b);

    // L1 — same file and both sides named symbols, but they share NONE: almost
    // certainly two different defects in one file. Demote rather than drop, since a
    // rephrasing can legitimately name different helpers.
    const disjoint = cmp.symbolOverlap === 0 && !cmp.lineHit;
    if (sim >= threshold) {
      return disjoint
        ? res("maybe", sim, "L1-anchor", `token overlap ${sim.toFixed(2)} but anchors share no symbol — likely distinct defects in one file`, { anchor: cmp })
        : res("match", sim, "L0-similarity", `token overlap ${sim.toFixed(2)} ≥ ${threshold}${cmp.sharedSymbols ? `, ${cmp.sharedSymbols} shared symbol(s)` : ""}`, { anchor: cmp });
    }
    // below the token bar but anchors agree strongly → worth a look, not a match
    if (cmp.lineHit || (cmp.symbolOverlap != null && cmp.symbolOverlap >= 0.5)) {
      return res("maybe", sim, "L1-anchor", `token overlap ${sim.toFixed(2)} < ${threshold} but anchors agree`, { anchor: cmp });
    }
    return res("no", sim, "L0-similarity", `token overlap ${sim.toFixed(2)} < ${threshold}`, { anchor: cmp });
  }

  // ---- cross-source path: L2 soft location gate ----------------------------
  const loc = locationScore(a, b, anA, anB);
  const tokens = tokenOverlap(a.summary, b.summary);
  const content = Math.max(tokens, cmp.symbolOverlap ?? 0);
  const anchorsAgree = cmp.lineHit || cmp.sharedSymbols > 0;
  // Anchors DISAGREE only when both sides named symbols and share none. A null
  // symbolOverlap means one side named nothing — no evidence either way, which must
  // not be read as disagreement (the same null-vs-zero distinction as the L0 gate).
  const anchorsDisagree = cmp.symbolOverlap === 0 && !cmp.lineHit;

  // Never match on text alone across sources: no location tie AND no anchor
  // agreement ⇒ no. (This is the floodgate the file-only matcher opened.)
  if (loc === 0 && !anchorsAgree) {
    return res("no", 0, "L2-xsource", "no location tie and no shared anchor symbol", { anchor: cmp });
  }
  // Combined score: location and content must BOTH contribute. Weights are
  // provisional — calibration is a deferred decision (design §7).
  const score = 0.5 * Math.max(loc, anchorsAgree ? 0.6 : 0) + 0.5 * content;
  if (loc >= 0.6 && content >= threshold && !anchorsDisagree) {
    return res("match", score, "L2-xsource",
      `location ${loc}, content ${content.toFixed(2)}${anchorsAgree ? ", shared anchor" : ""}`, { anchor: cmp });
  }
  const why = anchorsDisagree ? "anchors name disjoint symbols" : `location ${loc}, content ${content.toFixed(2)}`;
  return res("maybe", score, "L2-xsource", `partial evidence (${why}) — needs adjudication`, { anchor: cmp });
}

/** Token containment between two free-text summaries (no lens/file gate). */
export function tokenOverlap(s1, s2) {
  const ta = summaryTokens(s1); const tb = summaryTokens(s2);
  if (ta.length === 0 || tb.length === 0) return 0;
  const B = new Set(tb);
  let shared = 0;
  for (const t of ta) if (B.has(t)) shared++;
  return shared / Math.min(ta.length, tb.length);
}

/**
 * Adapt a stored finding label into the shape the matcher compares. A label is
 * addressed by `finding_key` = `file::lowercased-summary`, so the file and the
 * defect text are recoverable from the key itself; `evidence`/`kind` enrich it when
 * the annotator supplied them. Split on the FIRST `::` — a summary may contain it.
 */
export function labelToFinding(label) {
  const key = String(label?.finding_key ?? "");
  const i = key.indexOf("::");
  return {
    lens: label?.kind ?? null, // labels record `kind`, not the panel's lens
    file: i === -1 ? "" : key.slice(0, i),
    summary: i === -1 ? key : key.slice(i + 2),
    evidence: label?.evidence ?? "",
  };
}

/**
 * Adapt a verifier stage artifact into matcher shape. `input.finding` carries the
 * full summary + evidence (the anchor source); `instance` supplies lens and the key.
 */
export function artifactToFinding(art) {
  const f = art?.input?.finding ?? {};
  const key = String(art?.instance?.finding_key ?? "");
  const i = key.indexOf("::");
  return {
    lens: art?.instance?.lens_id ?? null,
    file: f.file ?? (i === -1 ? "" : key.slice(0, i)),
    summary: f.summary ?? (i === -1 ? key : key.slice(i + 2)),
    evidence: f.evidence ?? "",
  };
}

/**
 * Best match for `needle` among `candidates`. Returns
 * `{ index, candidate, result }` for the highest-scoring non-`no` pair, or null.
 * Ties break toward `match` over `maybe`, then higher score — so a caller can
 * treat `result.verdict === "maybe"` as "queue for a human" (owner-agnostic: the
 * queue works solo or as an inter-annotator sample).
 */
export function bestMatch(needle, candidates, opts = {}) {
  let best = null;
  (candidates ?? []).forEach((candidate, index) => {
    const result = matchFindings(needle, candidate, opts);
    if (result.verdict === "no") return;
    const rank = (r) => (r.verdict === "match" ? 1 : 0) * 10 + r.score;
    if (!best || rank(result) > rank(best.result)) best = { index, candidate, result };
  });
  return best;
}
