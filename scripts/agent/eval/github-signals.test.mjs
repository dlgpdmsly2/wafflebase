import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAuthor, parseCodeRabbitSeverity, parseDisposition, buildThreads,
  extractSignals, githubSignalForFinding,
} from "./github-signals.mjs";

test("classifyAuthor: pipeline bot is NOT independent (the circularity guard)", () => {
  assert.equal(classifyAuthor({ login: "yorkie-agent[bot]", type: "Bot" }), "pipeline-bot");
  assert.equal(classifyAuthor({ login: "coderabbitai[bot]", type: "Bot" }), "independent-bot");
  assert.equal(classifyAuthor({ login: "codecov[bot]", type: "Bot" }), "noise-bot");
  assert.equal(classifyAuthor({ login: "hackerwins", type: "User" }), "human");
  assert.equal(classifyAuthor({ login: "some-new-bot", type: "Bot" }), "noise-bot"); // unknown bot → noise
});

test("parseCodeRabbitSeverity: reads the severity word from the header line", () => {
  assert.equal(parseCodeRabbitSeverity("_🗄️ Data Integrity_ | _🟠 Major_ | _⚡ Quick win_\n\ndetails"), "major");
  assert.equal(parseCodeRabbitSeverity("_🔴 Critical_ issue\nbody"), "critical");
  assert.equal(parseCodeRabbitSeverity("just a comment with no header"), null);
});

test("parseDisposition: done / rejected / deferred / null", () => {
  assert.equal(parseDisposition("Done in 3c684e3c — added coordinate assertions."), "done");
  assert.equal(parseDisposition("Fixed, thanks."), "done");
  // won't-fix WITH a not-a-defect reason → rejected
  assert.equal(parseDisposition("Deferred (won't fix) — this is an example snippet inside the historical plan, not shipped code."), "rejected");
  assert.equal(parseDisposition("Deferred (won't fix) — historical plan text."), "rejected");
  // generic won't-fix, no reality judgement → deferred
  assert.equal(parseDisposition("Won't fix for now, tracking separately."), "deferred");
  assert.equal(parseDisposition("Thanks for the review!"), null);
});

// Fixtures modeled on the real pr-430 thread: coderabbit finding ← author reply.
const crFinding = (id, path, line, sev = "🟠 Major") => ({
  id, path, line, in_reply_to_id: null,
  user: { login: "coderabbitai[bot]", type: "Bot" },
  body: `_🗄️ Category_ | _${sev}_ | _⚡ Quick win_\n\n<details>…</details>`,
});
const reply = (id, replyTo, login, body, type = "User") => ({ id, in_reply_to_id: replyTo, user: { login, type }, body });

test("buildThreads: roots at independent-bot findings, attaches replies", () => {
  const inline = [
    crFinding(1, "a.ts", 10),
    reply(2, 1, "hackerwins", "Done in abc123"),
    reply(3, 1, "coderabbitai[bot]", "Great!", "Bot"),
    crFinding(4, "b.ts", 20),
    { id: 5, in_reply_to_id: null, user: { login: "hackerwins", type: "User" }, body: "a human root comment" }, // ignored (not a bot finding)
  ];
  const threads = buildThreads(inline);
  assert.equal(threads.length, 2);
  assert.equal(threads[0].finding.id, 1);
  assert.equal(threads[0].replies.length, 2);
});

test("extractSignals: independent findings carry severity + human disposition", () => {
  const inline = [
    crFinding(1, "a.ts", 10, "🟠 Major"),
    reply(2, 1, "hackerwins", "Done in abc — fixed the guard."),
    crFinding(4, "b.ts", 20, "🟡 Minor"),
    reply(5, 4, "hackerwins", "Deferred (won't fix) — historical plan text, not shipped."),
    crFinding(6, "c.ts", 30, "🟠 Major"), // no human reply
  ];
  const reviews = [
    { user: { login: "hackerwins", type: "User" }, state: "APPROVED" },
    { user: { login: "coderabbitai[bot]", type: "Bot" }, state: "COMMENTED" }, // not human → excluded
  ];
  const sig = extractSignals({ inline, reviews, meta: { linked_issue: 487 } });
  assert.equal(sig.independent_findings.length, 3);
  const byFile = Object.fromEntries(sig.independent_findings.map((f) => [f.file, f]));
  assert.equal(byFile["a.ts"].severity, "major");
  assert.equal(byFile["a.ts"].human_disposition, "done");
  assert.equal(byFile["b.ts"].human_disposition, "rejected");
  assert.equal(byFile["c.ts"].human_disposition, null);
  assert.deepEqual(sig.human_review_states, [{ author: "hackerwins", state: "APPROVED" }]);
  assert.equal(sig.linked_issue, 487);
});

test("githubSignalForFinding: co-locates by file+line window and derives is_real", () => {
  const extracted = extractSignals({
    inline: [
      crFinding(1, "a.ts", 100), reply(2, 1, "hackerwins", "Done in abc"),
      crFinding(3, "b.ts", 200), reply(4, 3, "hackerwins", "Deferred — false-positive, intentional."),
    ],
  });
  // author-confirmed → is_real true, within the line window
  const s1 = githubSignalForFinding({ file: "a.ts", line: 108 }, extracted);
  assert.equal(s1.is_real, true);
  assert.equal(s1.independent_flag, true);
  assert.equal(s1.human_disposition, "done");
  // author-rejected → is_real false
  const s2 = githubSignalForFinding({ file: "b.ts", line: 200 }, extracted);
  assert.equal(s2.is_real, false);
  // out of the line window → no co-location
  assert.equal(githubSignalForFinding({ file: "a.ts", line: 300 }, extracted), null);
  // different file → no co-location
  assert.equal(githubSignalForFinding({ file: "z.ts", line: 100 }, extracted), null);
});

test("githubSignalForFinding: independent flag with no disposition → is_real null (unsettled)", () => {
  const extracted = extractSignals({ inline: [crFinding(1, "a.ts", 50)] }); // no human reply
  const s = githubSignalForFinding({ file: "a.ts", line: 50 }, extracted);
  assert.equal(s.is_real, null);          // flagged independently, but reality unsettled
  assert.equal(s.independent_flag, true);
});

test("githubSignalForFinding: file-only match when a line is unavailable", () => {
  const extracted = extractSignals({ inline: [crFinding(1, "a.ts", null), reply(2, 1, "hackerwins", "Done")] });
  const s = githubSignalForFinding({ file: "a.ts", line: null }, extracted);
  assert.equal(s.is_real, true);
});
