// Ported from the completed R01 investigation. Expected occurrence is identity, not retention.
const { EditorSelection } = require("@codemirror/state");
const { undo, redo } = require("@codemirror/commands");
function occurrences(text, exact) { const out = []; for (let i = text.indexOf(exact); i >= 0; i = text.indexOf(exact, i + 1)) out.push(i); return out; }

// ---- edit helpers (operate on a live EditorView) ----
function nthPos(view, needle, n) { const doc = view.state.doc.toString(); const all = occurrences(doc, needle); if (n < 0) n = all.length + n; if (all[n] === undefined) throw new Error(`no ${needle}#${n}`); return all[n]; }
const E = {
  select(view, needle, n = 0) { const at = nthPos(view, needle, n); view.dispatch({ selection: EditorSelection.single(at, at + needle.length) }); },
  caret(view, needle, n = 0, offset = 1) { view.dispatch({ selection: EditorSelection.cursor(nthPos(view, needle, n) + offset) }); },
  cmd(view, name) { const r = view.bindarsHandle.executeFormatting(name); if (!r.applied) throw new Error(`${name} refused: ${r.reason}`); },
  link(view, destination) { view.bindarsHandle.beginLink(); const form = view.bindarsLinkForm(); if (!form) throw Error('no link form'); const r = view.bindarsHandle.applyLink(form.id, { label: form.label, destination }); if (!r.applied) throw Error(r.reason); },
  insertAt(view, at, text) { view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: "input.type" }); },
  typeAfter(view, needle, n, text) { E.insertAt(view, nthPos(view, needle, n) + needle.length, text); },
  typeBefore(view, needle, n, text) { E.insertAt(view, nthPos(view, needle, n), text); },
  typeEnd(view, text) { E.insertAt(view, view.state.doc.length, text); },
  replace(view, needle, n, text) { const at = nthPos(view, needle, n); view.dispatch({ changes: { from: at, to: at + needle.length, insert: text }, userEvent: "input.type" }); },
  remove(view, needle, n) { E.replace(view, needle, n, ""); },
  // cut text and paste it at a later needle (two observed transactions)
  move(view, needle, n, beforeNeedle, m) { const at = nthPos(view, needle, n); view.dispatch({ changes: { from: at, to: at + needle.length }, userEvent: "delete.cut" }); const to = nthPos(view, beforeNeedle, m); view.dispatch({ changes: { from: to, insert: needle }, userEvent: "input.paste" }); },
  undo(view) { if (!undo(view)) throw new Error("undo failed"); },
  redo(view) { if (!redo(view)) throw new Error("redo failed"); },
};

const P = "The observatory team records the amber signal while the surrounding context stays deliberately identical for this recovery check.";
const W05 = "# Workflow check\n\nReading the **cobalt** finding carefully helps connect the observation with a clear explanation and a useful next step. This unique passage will carry the saved note through an ordinary revision.\n\nConsult the [reference](<https://example.com/reference>) before revising the *conclusion.*\n\n- Review observations.\n- Compare conclusions.\n\nThe observatory team records the amber signal while the surrounding context stays deliberately identical for this recovery check.\n\nThe observatory team records the amber signal while the surrounding context stays deliberately identical for this recovery check.\n\nA final sentence leaves room for an unrelated revision.\n";
const SAME = "A".repeat(40) + "quote" + "B".repeat(40);
const BASE = `# Notes\n\nIntro paragraph about the session.\n\n${P}\n\nMiddle paragraph with a few words.\n\n${P}\n\nClosing paragraph here.\n`;

// expected: index of the intended occurrence of `exact` in the NEW rendered text, or null if the passage itself is gone.
const scenarios = [
  { id: "S01 W05 native replica: italic 2nd amber -> type in final paragraph -> bold 2nd amber", source: W05, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.caret(v, "amber", 1); E.cmd(v, "italic"); E.typeEnd(v, "Revision: the next step is now explicit.\n"); E.caret(v, "amber", 1, 2); E.cmd(v, "bold"); } },
  { id: "S02 same-block duplicate (W05 probe replica): bold -> type new paragraph -> italic", source: SAME + " " + SAME, exact: "quote", nth: 1, expected: 1,
    edits: (v) => { E.caret(v, "quote", 1, 2); E.cmd(v, "bold"); E.typeEnd(v, "\n\nUnrelated typing."); E.caret(v, "quote", 1, 2); E.cmd(v, "italic"); } },
  { id: "S03 duplicate paragraphs: type above AND below the passage block", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.typeAfter(v, "Middle paragraph", 0, " (revised)"); E.typeAfter(v, "Closing paragraph", 0, " and a later thought"); } },
  { id: "S04 duplicate paragraphs: Link + heading + bullets elsewhere, bold inside passage block", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.select(v, "session", 0); E.link(v, "https://example.com/s"); E.caret(v, "Middle", 0); E.cmd(v, "h2"); E.caret(v, "Closing", 0); E.cmd(v, "bullets"); E.select(v, "signal", 1); E.cmd(v, "bold"); } },
  { id: "S05 duplicate paragraphs: delete the OTHER (first) copy", source: BASE, exact: "amber", nth: 1, expected: 0,
    edits: (v) => { E.remove(v, P + "\n\n", 0); } },
  { id: "S06 control: delete the SELECTED (second) copy; first survives", source: BASE, exact: "amber", nth: 1, expected: null,
    edits: (v) => { E.remove(v, "\n\n" + P, 1); } },
  { id: "S07 duplicate paragraphs: paste an identical copy directly above the highlighted block", source: BASE, exact: "amber", nth: 0, expected: 1,
    edits: (v) => { E.typeBefore(v, P, 0, P + "\n\n"); } },
  { id: "S08 cut the first copy and paste it after the second (reorder)", source: BASE, exact: "amber", nth: 1, expected: 0,
    edits: (v) => { E.move(v, P + "\n\n", 0, "Closing", 0); } },
  { id: "S09 in-block typo fix AFTER the passage (same paragraph)", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.replace(v, "deliberately", 1, "deliberatly"); E.typeEnd(v, "\nExtra."); } },
  { id: "S10 in-block edits on BOTH sides of the passage", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.typeBefore(v, "records the amber", 1, "now "); E.typeAfter(v, "amber signal", 1, " clearly"); } },
  { id: "S11 control: delete only the passage words in its block", source: BASE, exact: "amber", nth: 1, expected: null,
    edits: (v) => { E.remove(v, "amber ", 1); } },
  { id: "S12 control: replace the passage words", source: BASE, exact: "amber", nth: 1, expected: null,
    edits: (v) => { E.replace(v, "amber", 1, "umber"); } },
  { id: "S13 Undo/Redo: format + type, undo typing only, redo, then undo all", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.caret(v, "amber", 1); E.cmd(v, "italic"); E.typeEnd(v, "More.\n"); E.undo(v); E.redo(v); }, after: [
      { label: "after undo all (exact original source)", edits: (v) => { E.undo(v); E.undo(v); }, expected: 1 }] },
  { id: "S14 delete passage block, Undo, then type elsewhere", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.remove(v, "\n\n" + P, 1); E.undo(v); E.typeEnd(v, "Later.\n"); } },
  { id: "S15 convert passage paragraph to bullet", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.caret(v, "amber", 1); E.cmd(v, "bullets"); E.typeEnd(v, "x\n"); } },
  { id: "S16 convert passage paragraph to H2 and quote the other copy", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.caret(v, "amber", 1); E.cmd(v, "h2"); E.caret(v, "amber", 0); E.cmd(v, "quote"); } },
  { id: "S17 CRLF document, W05-style edits", source: BASE.replace(/\n/g, "\r\n"), exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.caret(v, "amber", 1); E.cmd(v, "italic"); E.typeAfter(v, "Middle paragraph", 0, " (revised)"); E.caret(v, "amber", 1, 2); E.cmd(v, "bold"); } },
  { id: "S18 frontmatter + duplicates in list items, type in another item", source: `---\ntitle: Study\n---\n\n- ${P}\n- Other item\n- ${P}\n`, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.typeAfter(v, "Other item", 0, " expanded"); E.caret(v, "amber", 1); E.cmd(v, "italic"); } },
  { id: "S19 smart punctuation in passage, duplicate paragraphs, edit elsewhere", source: `Intro.\n\nShe said "don't wait" -- then left.\n\nGap.\n\nShe said "don't wait" -- then left.\n`, exact: "“don’t wait”", nth: 1, expected: 1,
    edits: (v) => { E.typeAfter(v, "Gap", 0, " grows"); E.select(v, "left", 1); E.cmd(v, "bold"); } },
  { id: "S20 typing at the very start of the passage block (prepend words)", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.typeBefore(v, P, 1, "Later, "); } },
  { id: "S21 bold the FIRST word of the passage block (markup at block start)", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.select(v, "The observatory", 1); E.cmd(v, "bold"); } },
  { id: "S22 split the passage paragraph after the passage", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.typeAfter(v, "amber signal", 1, "\n\n"); } },
  { id: "S24 in-block MOVE of a same-block duplicate (counterexample for plain in-block diff)", source: "Intro.\n\nAlpha amber beta amber gamma.\n\nEnd.\n", exact: "amber", nth: 1, expected: 0,
    edits: (v) => { E.remove(v, "amber ", 0); E.typeAfter(v, "beta amber", 0, " amber"); } },
  { id: "S25 control: delete the passage word and retype it later in the same block", source: BASE, exact: "amber", nth: 1, expected: null,
    edits: (v) => { E.remove(v, "amber ", 1); E.typeAfter(v, "recovery check", 1, " amber"); } },
  { id: "S26 typo fix inside a block that holds both duplicates", source: SAME + " middle " + SAME, exact: "quote", nth: 1, expected: 1,
    edits: (v) => { E.replace(v, "middle", 0, "midle"); } },
  { id: "S27 paste identical copy at the block start AND edit the original on both sides (counterexample for gap identity)", source: BASE, exact: "amber", nth: 1, expected: 2,
    edits: (v) => { E.typeBefore(v, P, 1, P + "\n\n"); E.typeBefore(v, "records the amber", 2, "now "); E.typeAfter(v, "amber signal", 2, " clearly"); } },
  { id: "S28 select-replace a span that contains the passage with text that again contains it ('the amber' -> 'an amber')", source: BASE, exact: "amber", nth: 1, expected: null,
    edits: (v) => { E.replace(v, "the amber", 1, "an amber"); } },
  { id: "S29 merge the passage paragraph into the previous one (delete blank line)", source: BASE, exact: "amber", nth: 1, expected: 1,
    edits: (v) => { E.replace(v, "words.\n\n" + P, 0, "words. " + P); } },
  { id: "S30 KNOWN GAP: replace a phrase whose excerpt is split by markup, re-rendering the same excerpt at the same block offset", source: BASE.replace("amber signal while the surrounding context stays deliberately identical for this recovery check.\n\nClosing", "amber **signal** while the surrounding context stays deliberately identical for this recovery check.\n\nClosing"), exact: "amber signal", nth: 1, expected: null,
    edits: (v) => { E.replace(v, "the amber **signal**", 0, "an amber signal"); } },
  { id: "S31 DEFINITIONAL: select-replace the passage word with identical text (block renders identically)", source: BASE, exact: "amber", nth: 1, expected: null,
    edits: (v) => { E.replace(v, "amber", 1, "amber"); } },
  { id: "S32 duplicate paragraphs that BEGIN with inline code and math; edit elsewhere + bold inside", source: "Intro.\n\n`cfg` and $x$ then the amber signal repeats here.\n\nGap.\n\n`cfg` and $x$ then the amber signal repeats here.\n", exact: "amber signal", nth: 1, expected: 1,
    edits: (v) => { E.typeAfter(v, "Gap", 0, " widened"); E.select(v, "repeats", 1); E.cmd(v, "bold"); E.typeBefore(v, "`cfg`", 1, "Note: "); } },
  { id: "S33 same as S32 without typing before the block's first character", source: "Intro.\n\n`cfg` and $x$ then the amber signal repeats here.\n\nGap.\n\n`cfg` and $x$ then the amber signal repeats here.\n", exact: "amber signal", nth: 1, expected: 1,
    edits: (v) => { E.typeAfter(v, "Gap", 0, " widened"); E.select(v, "repeats", 1); E.cmd(v, "bold"); E.select(v, "Intro", 0); E.cmd(v, "italic"); } },
  { id: "S23 unique passage (control), mixed edits", source: W05, exact: "cobalt", nth: 0, expected: 0,
    edits: (v) => { E.caret(v, "amber", 1); E.cmd(v, "italic"); E.typeEnd(v, "Revision.\n"); E.typeAfter(v, "Reading the", 0, " very"); } },
];


const OUTLINE = '# Notes\n\n- first bullet\n- unique amber phrase after\n- last bullet\n';
module.exports = { scenarios, E, BASE, P, OUTLINE, occurrences };
