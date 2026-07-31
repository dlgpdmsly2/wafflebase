import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAnchor, anchorIsEmpty, compareAnchors, linesOverlap,
  matchFindings, tokenOverlap, bestMatch,
} from "./finding-matcher.mjs";

test("extractAnchor: pulls backticked symbols from real-shaped evidence", () => {
  // modeled on the pr-521 resolveRange finding
  const a = extractAnchor({
    file: "packages/sheets/src/model/core/coordinates.ts",
    summary: "`resolveRange` throws a raw TypeError on a reference without ':'",
    evidence: "`resolveRange` does `const [fromStr, toStr] = srng.split(':')`; `parsePartialRef(undefined)` dereferences `.replace`",
  });
  const lower = a.symbols.map((s) => s.toLowerCase());
  assert.ok(lower.includes("resolverange"));
  assert.ok(lower.includes("parsepartialref"));
  assert.ok(lower.includes("frompstr") === false); // sanity: made-up token absent
  assert.ok(!lower.includes("const")); // stopword dropped
});

test("extractAnchor: keeps dotted chains whole AND split into segments", () => {
  const a = extractAnchor({ file: "x.ts", summary: "`Sheet.getUsedBounds()` awaits per formula cell", evidence: "" });
  const lower = a.symbols.map((s) => s.toLowerCase());
  assert.ok(lower.includes("sheet.getusedbounds")); // whole chain
  assert.ok(lower.includes("getusedbounds"));        // segment
});

test("extractAnchor: prose call-sites count as symbols", () => {
  const a = extractAnchor({ file: "x.ts", summary: "the diff never updates extractFormulaRanges(), which still parses every token", evidence: "" });
  assert.ok(a.symbols.map((s) => s.toLowerCase()).includes("extractformularanges"));
});

test("extractAnchor: line hints → soft ranges (single and span)", () => {
  const a = extractAnchor({ file: "x.ts", summary: "introduces <Tooltip> at lines ~626-640", evidence: "throws at line 214" });
  assert.deepEqual(a.lines.sort((p, q) => p[0] - q[0]), [[214, 214], [626, 640]]);
});

test("extractAnchor: path:line suffix contributes a line", () => {
  const a = extractAnchor({ file: "a.ts", summary: "", evidence: "the input parser (input.ts:242) already treats TRUE/FALSE case-insensitively" });
  assert.ok(a.lines.some(([s, e]) => s === 242 && e === 242));
});

test("extractAnchor: names OTHER files but not the finding's own file", () => {
  const a = extractAnchor({
    file: "packages/sheets/src/formula/formula.ts",
    summary: "reconstructed string is fed to extractReferences in calculator.ts",
    evidence: "docs/design/sheets/formula.md claims whole-column highlighting; formula.ts is unchanged",
  });
  assert.ok(a.files.includes("calculator.ts"));
  assert.ok(a.files.includes("docs/design/sheets/formula.md"));
  assert.ok(!a.files.includes("packages/sheets/src/formula/formula.ts")); // own file excluded
});

test("extractAnchor: symbols are deduped case-insensitively, original casing kept", () => {
  const a = extractAnchor({ file: "x.ts", summary: "`toRange` then `toRange`", evidence: "`ToRange`" });
  const toRange = a.symbols.filter((s) => s.toLowerCase() === "torange");
  assert.equal(toRange.length, 1);
  assert.equal(toRange[0], "toRange"); // first-seen casing
});

test("anchorIsEmpty: true only when no symbol, line, or extra file", () => {
  assert.equal(anchorIsEmpty(extractAnchor({ file: "x.ts", summary: "a vague prose finding with no code or location", evidence: "" })), true);
  assert.equal(anchorIsEmpty(extractAnchor({ file: "x.ts", summary: "`foo()` bug", evidence: "" })), false);
});

// --- anchor comparison ------------------------------------------------------

test("linesOverlap: window-tolerant, never exact equality", () => {
  assert.equal(linesOverlap([[100, 100]], [[108, 108]]), true);  // within the 15-line window
  assert.equal(linesOverlap([[100, 100]], [[200, 200]]), false); // far apart
  assert.equal(linesOverlap([[100, 140]], [[135, 150]]), true);  // ranges genuinely overlap
  assert.equal(linesOverlap([], [[1, 1]]), false);               // nothing to compare
});

test("compareAnchors: symbol containment + null when one side names nothing", () => {
  const a = { symbols: ["resolveRange", "toRange"], lines: [], files: [] };
  const b = { symbols: ["resolveRange"], lines: [], files: [] };
  const c = compareAnchors(a, b);
  assert.equal(c.sharedSymbols, 1);
  assert.equal(c.symbolOverlap, 1);           // containment over the SMALLER set
  assert.equal(compareAnchors(a, { symbols: [], lines: [], files: [] }).symbolOverlap, null);
});

// --- L0 / L1 (same-run) -----------------------------------------------------

const pf = (file, summary, evidence = "", lens = "correctness") => ({ lens, file, summary, evidence });

test("matchFindings L0: two wordings of ONE defect in the same file → match", () => {
  const a = pf("arguments.ts", "blank-skip in `Arguments.iterate` makes MIN/MAX over an all-blank range return #NUM!");
  const b = pf("arguments.ts", "`Arguments.iterate` blank skipping causes MIN and MAX over blank ranges to return #NUM! instead of 0");
  const r = matchFindings(a, b);
  assert.equal(r.verdict, "match");
  assert.ok(r.score >= 0.3);
});

test("matchFindings L0: different file or lens → no (the same-run gate)", () => {
  const a = pf("a.ts", "`foo()` mishandles blank cells returning #NUM!");
  assert.equal(matchFindings(a, pf("b.ts", "`foo()` mishandles blank cells returning #NUM!")).verdict, "no");
  assert.equal(matchFindings(a, pf("a.ts", "`foo()` mishandles blank cells returning #NUM!", "", "security")).verdict, "no");
});

test("matchFindings L1: same file, high token overlap, but DISJOINT anchors → demoted to maybe", () => {
  // Two genuinely different defects that share generic vocabulary in one file.
  const a = pf("plugin.ts", "the relaxation accepts markers and changes paragraph interrupt behaviour for notes", "`isEmptyBulletLine` is the culprit");
  const b = pf("plugin.ts", "the relaxation accepts markers and changes paragraph interrupt behaviour for notes", "`getRuleFn` is the culprit");
  const r = matchFindings(a, b);
  assert.equal(r.verdict, "maybe");
  assert.equal(r.method, "L1-anchor");
  assert.match(r.reason, /share no symbol/);
});

test("matchFindings L1: below the token bar but anchors agree → maybe, not no", () => {
  const a = pf("x.ts", "guard is missing entirely here", "`toggleCheckboxAt` at lines 3837-3841");
  const b = pf("x.ts", "formula cells are silently overwritten by the toggle path", "`toggleCheckboxAt` at line 3840");
  const r = matchFindings(a, b);
  assert.equal(r.verdict, "maybe");
  assert.equal(r.method, "L1-anchor");
});

// --- L2 (cross-source) ------------------------------------------------------

test("matchFindings L2: cross-source, DIFFERENT files, same defect → match via evidence-named file", () => {
  // Our panel blames arguments.ts; the other source blames formula.ts but names
  // arguments.ts in its prose. The absolute file gate would wrongly score this 0.
  const panel = pf("packages/sheets/src/formula/arguments.ts",
    "blank-skip in `Arguments.iterate` makes MIN/MAX over an all-blank range return #NUM!");
  const other = {
    file: "packages/sheets/src/formula/functions-statistical.ts",
    summary: "MIN/MAX over an all-blank range returns #NUM! — blank-skip in `Arguments.iterate`",
    evidence: "root cause lives in packages/sheets/src/formula/arguments.ts",
  };
  assert.equal(matchFindings(panel, other).verdict, "no"); // same-run gate rejects (different file)
  const r = matchFindings(panel, other, { crossSource: true });
  assert.equal(r.verdict, "match");
  assert.equal(r.method, "L2-xsource");
});

test("matchFindings L2: never matches on text alone — no location tie and no shared symbol → no", () => {
  const a = pf("a.ts", "the validation guard is missing so invalid input is accepted downstream");
  const b = { file: "totally/other.ts", summary: "the validation guard is missing so invalid input is accepted downstream", evidence: "" };
  const r = matchFindings(a, b, { crossSource: true });
  assert.equal(r.verdict, "no");
  assert.match(r.reason, /no location tie/);
});

test("matchFindings L2: same file but only weak content agreement → maybe (adjudication queue)", () => {
  const a = pf("plugin.ts", "`isEmptyBulletLine` has no 4-space indent ceiling");
  const b = { file: "plugin.ts", summary: "nitpick about `isEmptyBulletLine` markers", evidence: "at line 214" };
  const r = matchFindings(a, b, { crossSource: true });
  assert.ok(r.verdict === "maybe" || r.verdict === "match"); // shares a symbol + file
  assert.equal(r.method, "L2-xsource");
});

test("matchFindings: basename agreement counts as a partial location tie", () => {
  const a = pf("packages/sheets/src/formula/arguments.ts", "`Arguments.iterate` blank skip breaks MIN and MAX aggregation");
  const b = { file: "arguments.ts", summary: "`Arguments.iterate` blank skip breaks MIN and MAX aggregation", evidence: "" };
  assert.equal(matchFindings(a, b, { crossSource: true }).verdict, "match");
});

test("matchFindings: missing operand → no, never a throw", () => {
  assert.equal(matchFindings(null, pf("a.ts", "x")).verdict, "no");
  assert.equal(matchFindings(pf("a.ts", "x"), undefined).verdict, "no");
});

test("tokenOverlap: containment over the smaller summary; empty → 0", () => {
  assert.equal(tokenOverlap("blank skip breaks minmax aggregation", "blank skip breaks minmax aggregation"), 1);
  assert.equal(tokenOverlap("", "anything here"), 0);
});

test("bestMatch: picks the strongest candidate and prefers match over maybe", () => {
  const needle = pf("a.ts", "`resolveRange` throws a raw TypeError on a reference without a colon");
  const candidates = [
    pf("a.ts", "completely unrelated rendering glitch in the toolbar widget"),
    pf("a.ts", "`resolveRange` raises a raw TypeError for a reference lacking a colon"),
  ];
  const best = bestMatch(needle, candidates);
  assert.equal(best.index, 1);
  assert.equal(best.result.verdict, "match");
  // nothing plausible at all → null
  assert.equal(bestMatch(needle, [pf("z.ts", "unrelated")]), null);
});
