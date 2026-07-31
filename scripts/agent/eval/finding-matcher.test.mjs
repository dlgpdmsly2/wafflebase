import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnchor, anchorIsEmpty } from "./finding-matcher.mjs";

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
