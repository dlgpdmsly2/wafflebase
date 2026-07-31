// github-signals — B1 GitHub signal miner (precision signals only; revert/hot-fix
// mining = recall, deferred per pilot scope). Harvests INDEPENDENT signals about a
// source PR to corroborate/contradict the panel's findings during B2 adjudication:
//
//   - independent-bot findings — a THIRD-PARTY AI reviewer (CodeRabbit) already on
//     the PR, a different model family from the wafflebase panel, so its findings
//     are a genuinely independent vote (the "independent judge" of overview §3.2,
//     for free). Its inline body carries a parseable severity header.
//   - human disposition — the PR author's reply to each bot finding ("Done in
//     <sha>" ⟹ confirmed & fixed; "Deferred — historical/not shipped" ⟹ judged a
//     non-issue). A real human vote on that specific finding.
//   - human review states — approve / changes_requested by a non-pipeline human.
//
// Sources are classified so the CIRCULAR one is never mistaken for independent:
// `yorkie-agent` IS the wafflebase pipeline (using it to grade itself is the §4
// trap); codecov / github-actions are noise. Only humans and independent bots vote.
//
// Pure core (classify / parse / thread / co-locate) is exported and unit-tested; a
// thin `gh api`-backed fetch assembles the bundle. Signals key by finding_key via
// co-location (file + line window) so they slot into signal-harvest's mergeSignals.
// The location match is COARSE (the V2 matcher problem in miniature) — a matched
// signal is a candidate for B2, not a settled label.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Author classification. Logins are the GitHub account names; `yorkie-agent` is the
// wafflebase issue→PR pipeline itself (CIRCULAR — never an independent signal).
export const PIPELINE_BOTS = new Set(["yorkie-agent"]);
export const INDEPENDENT_BOTS = new Set(["coderabbitai"]);
export const NOISE_BOTS = new Set(["codecov", "github-actions", "vercel"]);

/** 'human' | 'independent-bot' | 'pipeline-bot' | 'noise-bot'. type is the GitHub
 *  user type ("User" | "Bot"). login is normalized ("coderabbitai[bot]" → "coderabbitai"). */
export function classifyAuthor({ login, type } = {}) {
  const name = String(login ?? "").replace(/\[bot\]$/, "").toLowerCase();
  if (PIPELINE_BOTS.has(name)) return "pipeline-bot";
  if (INDEPENDENT_BOTS.has(name)) return "independent-bot";
  if (NOISE_BOTS.has(name)) return "noise-bot";
  return type === "Bot" ? "noise-bot" : "human"; // unknown bots are noise until vetted
}

const SEVERITY_WORDS = ["critical", "major", "minor", "nit"];

/** CodeRabbit inline findings lead with `_<category>_ | _<emoji> <Severity>_ | …`.
 *  Pull the first severity word from the header line. null when absent. */
export function parseCodeRabbitSeverity(body) {
  const header = String(body ?? "").split("\n", 1)[0].toLowerCase();
  for (const w of SEVERITY_WORDS) if (header.includes(w)) return w;
  return null;
}

/** The author's disposition of a bot finding, from the reply body:
 *   'done'      — confirmed real and fixed ("Done in <sha>", "Fixed", "Addressed")
 *   'rejected'  — judged a non-issue ("Deferred/won't fix" WITH a not-a-defect
 *                 reason: historical/example/not shipped/false positive/intentional)
 *   'deferred'  — punted without judging reality (generic won't-fix)
 *   null        — no clear disposition. */
export function parseDisposition(body) {
  const b = String(body ?? "").toLowerCase();
  const head = b.slice(0, 80);
  if (/^\s*(done|fixed|addressed|resolved)\b/.test(head)) return "done";
  const wontFix = /\b(deferred|won'?t fix|not fixing|out of scope)\b/.test(head);
  if (wontFix) {
    const nonDefect = /(historical|example snippet|not shipped|not a bug|false[- ]positive|intentional|by design|as designed|plan text)/.test(b);
    return nonDefect ? "rejected" : "deferred";
  }
  return null;
}

/** Group inline comments into threads rooted at the finding (a comment with no
 *  in_reply_to_id). Returns [{ finding, replies: [...] }] for findings authored by
 *  an independent bot; other roots are ignored (we only vote on independent finds). */
export function buildThreads(inlineComments) {
  const byId = new Map();
  for (const c of inlineComments || []) byId.set(c.id, c);
  const roots = (inlineComments || []).filter((c) => c.in_reply_to_id == null);
  const threads = [];
  for (const root of roots) {
    if (classifyAuthor(root.user) !== "independent-bot") continue;
    const replies = (inlineComments || []).filter((c) => c.in_reply_to_id === root.id);
    threads.push({ finding: root, replies });
  }
  return threads;
}

/** Turn a raw bundle into structured, classified signals. `inline` = review
 *  comments, `reviews` = PR reviews, `meta` = { linked_issue }. */
export function extractSignals({ inline = [], reviews = [], meta = {} } = {}) {
  const threads = buildThreads(inline);
  const independent_findings = threads.map(({ finding, replies }) => {
    const humanReply = replies.find((r) => classifyAuthor(r.user) === "human");
    return {
      id: finding.id,
      file: finding.path,
      line: finding.line ?? finding.original_line ?? null,
      severity: parseCodeRabbitSeverity(finding.body),
      source: classifyAuthor(finding.user), // 'independent-bot'
      human_disposition: humanReply ? parseDisposition(humanReply.body) : null,
      evidence: String(finding.body ?? "").split("\n", 1)[0],
    };
  });
  const human_review_states = (reviews || [])
    .filter((r) => classifyAuthor(r.user) === "human" && r.state)
    .map((r) => ({ author: r.user?.login, state: r.state }));
  return { independent_findings, human_review_states, linked_issue: meta.linked_issue ?? null };
}

/**
 * Co-locate an independent finding to a panel finding by file + line window, and
 * derive an is_real vote:
 *   author 'done'      ⟹ is_real true  (independently flagged AND author fixed it)
 *   author 'rejected'  ⟹ is_real false (author judged it a non-defect)
 *   'deferred' / none  ⟹ is_real null  (independently flagged, but reality unsettled)
 * Returns null when nothing co-locates. `panelFinding` needs { file, line? }.
 */
export function githubSignalForFinding(panelFinding, extracted, { lineWindow = 15 } = {}) {
  const pf = panelFinding || {};
  const hits = (extracted?.independent_findings || []).filter((g) => {
    if (!g.file || g.file !== pf.file) return false;
    if (pf.line == null || g.line == null) return true; // file-only match when a line is missing
    return Math.abs(g.line - pf.line) <= lineWindow;
  });
  if (hits.length === 0) return null;
  const hit = hits[0];
  const is_real = hit.human_disposition === "done" ? true
    : hit.human_disposition === "rejected" ? false
    : null;
  return {
    is_real,
    source: "github",
    independent_flag: true,
    coderabbit_severity: hit.severity,
    human_disposition: hit.human_disposition,
    evidence: `independent (CodeRabbit) flagged ${hit.file}:${hit.line ?? "?"} [${hit.severity ?? "?"}]` +
      (hit.human_disposition ? `; author ${hit.human_disposition}` : "; no author reply"),
  };
}

// --- gh-backed fetch --------------------------------------------------------

async function gh(args) {
  const { stdout } = await execFileP("gh", args, { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Fetch + assemble the raw bundle for a source PR from GitHub. */
export async function fetchBundle(repo, prNumber) {
  const base = `repos/${repo}`;
  const [inline, reviews, pr] = await Promise.all([
    gh(["api", `${base}/pulls/${prNumber}/comments`, "--paginate"]),
    gh(["api", `${base}/pulls/${prNumber}/reviews`, "--paginate"]),
    gh(["api", `${base}/pulls/${prNumber}`]),
  ]);
  const closes = [...String(pr.body ?? "").matchAll(/(?:clos|fix|resolv)\w*\s+#(\d+)/gi)].map((m) => Number(m[1]));
  return { inline, reviews, meta: { linked_issue: closes[0] ?? null } };
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (!process.argv[i].startsWith("--")) continue;
    const key = process.argv[i].slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith("--")) { args[key] = true; i++; } else { args[key] = next; i++; }
  }
  if (!args.repo || !args.pr) {
    console.error("usage: github-signals.mjs --repo <owner/name> --pr <number> [--json]");
    process.exit(2);
  }
  const bundle = await fetchBundle(args.repo, args.pr);
  const sig = extractSignals(bundle);
  console.error(
    `github-signals ${args.repo}#${args.pr}: ${sig.independent_findings.length} independent findings ` +
    `(${sig.independent_findings.filter((f) => f.human_disposition === "done").length} author-confirmed, ` +
    `${sig.independent_findings.filter((f) => f.human_disposition === "rejected").length} author-rejected), ` +
    `human reviews: ${sig.human_review_states.map((r) => r.state).join(",") || "none"}, ` +
    `linked issue: ${sig.linked_issue ?? "none"}`
  );
  for (const f of sig.independent_findings) {
    console.error(`  ${f.file}:${f.line ?? "?"} [${f.severity ?? "?"}] disposition=${f.human_disposition ?? "-"}`);
  }
  if (args.json) console.log(JSON.stringify(sig, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("github-signals failed:", e); process.exit(1); });
}
