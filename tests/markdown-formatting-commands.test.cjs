const test = require("node:test");
const assert = require("node:assert/strict");
const { EditorSelection, EditorState } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { history, redo, undo, redoDepth, undoDepth } = require("@codemirror/commands");
const { forceParsing, syntaxTree, syntaxTreeAvailable, Language } = require("@codemirror/language");
const { commonmarkLanguage } = require("@codemirror/lang-markdown");
const { parser: commonmarkParser, GFM } = require("@lezer/markdown");
const {
  markdownFormattingExtensions,
  markdownGfmParser,
} = require("../.tmp/workspace-tests/src/components/markdown-decorations.js");
const {
  applyEmphasisCommand,
  emphasisCommandStatus,
} = require("../.tmp/workspace-tests/src/components/markdown-formatting-commands.js");

const PARTIAL = "Select the whole formatted span, or place the cursor inside it.";
const MIXED = "Select one plain phrase or one formatted span.";
const CROSS = "Select text in a single paragraph.";
const MULTILINE = "Select text on one line.";
const MULTI = "Use one selection to format text.";
const LOADING = "Formatting context is still loading.";
const METADATA = "Move out of the document details to format text.";
const MATH = "Move out of math to format text.";
const CODE = "Move out of code to format text.";
const HTML = "Move out of HTML to format text.";
const TABLE = "Move out of the table to format text.";
const LINK = "Move out of the link to format text.";
const MARKER = "Select the heading text, not its marker.";
const COMPOSITION = "Finish the current composition before formatting.";
const READ_ONLY = "This document cannot be edited.";
const CHANGED_SYNTAX = "This would change other Markdown. Edit the markers directly.";
const CHECKBOX = "Select the checklist text, not its checkbox.";

function emptyReason(command) {
  return command === "bold"
    ? "Select text to make it bold."
    : "Select text to make it italic.";
}

function literalReason(command) {
  return command === "bold"
    ? "This text would not appear bold. Select different text."
    : "This text would not appear italic. Select different text.";
}

const { notation, createView, withView, useSpec, selected } = require("./_helpers/markdown-command-view.cjs");

function expectRefusal(view, command, reason) {
  const before = view.state.sliceDoc();
  const anchor = view.state.selection.main.anchor;
  const head = view.state.selection.main.head;
  const status = emphasisCommandStatus(view.state, command, view.composing);
  const result = applyEmphasisCommand(view, command);
  assert.equal(status.available, false, before);
  assert.equal(status.active, false, before);
  assert.equal(status.reason, reason, before);
  assert.deepEqual(result, {
    available: false,
    active: false,
    reason,
    handled: true,
    applied: false,
  });
  assert.equal(view.state.sliceDoc(), before);
  assert.equal(view.state.selection.main.anchor, anchor);
  assert.equal(view.state.selection.main.head, head);
  assert.equal(undo(view), false);
}

function expectFormat(view, command, expected, { active = false, selectedText, cursor } = {}) {
  const status = emphasisCommandStatus(view.state, command, view.composing);
  assert.equal(status.available, true);
  assert.equal(status.active, active);
  assert.equal(status.reason, null);
  const result = applyEmphasisCommand(view, command);
  assert.equal(result.applied, true);
  assert.equal(result.handled, true);
  assert.equal(result.reason, null);
  assert.equal(result.active, active);
  const caret = expected.indexOf("|");
  const open = expected.indexOf("[[");
  const close = expected.indexOf("]]");
  if (caret >= 0) {
    assert.equal(view.state.sliceDoc(), expected.replace("|", ""));
    assert.equal(view.state.selection.main.empty, true);
    assert.equal(view.state.selection.main.head, caret);
  } else if (open >= 0 && close > open) {
    const doc = expected.slice(0, open) + expected.slice(open + 2, close) + expected.slice(close + 2);
    assert.equal(view.state.sliceDoc(), doc);
    assert.equal(selected(view), expected.slice(open + 2, close));
    assert.equal(view.state.selection.main.anchor < view.state.selection.main.head, true);
  } else {
    assert.equal(view.state.sliceDoc(), expected);
  }
  if (selectedText != null) assert.equal(selected(view), selectedText);
  if (cursor != null) assert.equal(view.state.selection.main.head, cursor);
}

async function readerHtml(markdown) {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const Markdown = (await import("react-markdown")).default;
  const { remarkPlugins } = require("../.tmp/workspace-tests/src/lib/markdown-plugins.js");
  const { extractFrontmatter } = require("../.tmp/workspace-tests/src/lib/frontmatter.js");
  return renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins }, extractFrontmatter(markdown).body));
}

test("bold and italic wrap a phrase, a word at the caret, and punctuation that parses", () => {
  useSpec("before [[alpha beta]] after", {}, (view) => {
    expectFormat(view, "bold", "before **[[alpha beta]]** after");
  });
  useSpec("before [[alpha beta]] after", {}, (view) => {
    expectFormat(view, "italic", "before *[[alpha beta]]* after");
  });
  useSpec("al|pha", {}, (view) => {
    expectFormat(view, "bold", "**al|pha**");
  });
  useSpec("|alpha", {}, (view) => {
    expectFormat(view, "italic", "*|alpha*");
  });
  useSpec("alpha| beta", {}, (view) => {
    expectFormat(view, "bold", "**alpha|** beta");
  });
  useSpec("[[  alpha  ]]", {}, (view) => {
    expectFormat(view, "bold", "  **[[alpha]]**  ");
  });
  useSpec("[[Note:]] text", {}, (view) => {
    expectFormat(view, "bold", "**[[Note:]]** text");
  });
  useSpec("[[.]]", {}, (view) => {
    expectFormat(view, "bold", "**[[.]]**");
  });
  useSpec("- [[item]]", {}, (view) => {
    expectFormat(view, "bold", "- **[[item]]**");
  });
  useSpec("> [[hello]]", {}, (view) => {
    expectFormat(view, "italic", "> *[[hello]]*");
  });
  useSpec("# [[Title]]", {}, (view) => {
    expectFormat(view, "bold", "# **[[Title]]**");
  });
  useSpec("Ti|tle\n=====", {}, (view) => {
    expectFormat(view, "bold", "**Ti|tle**\n=====");
  });
});

test("a reversed selection stays reversed around the formatted words", () => {
  const parsed = notation("[[alpha]]");
  const reversed = EditorSelection.single(parsed.selection.main.to, parsed.selection.main.from);
  withView(parsed.doc, reversed, {}, (view) => {
    const result = applyEmphasisCommand(view, "bold");
    assert.equal(result.applied, true);
    assert.equal(view.state.sliceDoc(), "**alpha**");
    assert.equal(selected(view), "alpha");
    assert.equal(view.state.selection.main.anchor > view.state.selection.main.head, true);
  });
});

test("a selection that ends at the next line does not format that line", () => {
  useSpec("[[alpha\n]]beta", {}, (view) => {
    expectFormat(view, "bold", "**[[alpha]]**\nbeta");
  });
});

test("bold and italic toggle complete spans and keep the other style", () => {
  useSpec("**alpha be|ta**", {}, (view) => {
    expectFormat(view, "bold", "alpha be|ta", { active: true });
  });
  useSpec("**[[alpha beta]]**", {}, (view) => {
    expectFormat(view, "bold", "[[alpha beta]]", { active: true });
  });
  useSpec("[[**alpha beta**]]", {}, (view) => {
    expectFormat(view, "bold", "[[alpha beta]]", { active: true });
  });
  useSpec("*[[alpha beta]]*", {}, (view) => {
    expectFormat(view, "italic", "[[alpha beta]]", { active: true });
  });
  useSpec("__al|pha__", {}, (view) => {
    expectFormat(view, "bold", "al|pha", { active: true });
  });
  useSpec("_al|pha_", {}, (view) => {
    expectFormat(view, "italic", "al|pha", { active: true });
  });
  useSpec("***al|pha***", {}, (view) => {
    expectFormat(view, "bold", "*al|pha*", { active: true });
  });
  useSpec("***al|pha***", {}, (view) => {
    expectFormat(view, "italic", "**al|pha**", { active: true });
  });
  useSpec("**alpha *be|ta* gamma**", {}, (view) => {
    expectFormat(view, "bold", "alpha *be|ta* gamma", { active: true });
  });
  useSpec("*[[alpha]]*", {}, (view) => {
    expectFormat(view, "bold", "***[[alpha]]***");
  });
  useSpec("_[[alpha]]_", {}, (view) => {
    expectFormat(view, "bold", "_**[[alpha]]**_");
  });
  useSpec("[[alpha]]", {}, (view) => {
    expectFormat(view, "italic", "*[[alpha]]*");
    expectFormat(view, "bold", "***[[alpha]]***", { active: false });
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "*alpha*");
  });
  useSpec("[[***alpha***]]", {}, (view) => {
    expectFormat(view, "italic", "[[**alpha**]]", { active: true });
  });
  useSpec("[[***alpha***]]", {}, (view) => {
    expectRefusal(view, "bold", MIXED);
  });
  useSpec("___al|pha___", {}, (view) => {
    expectFormat(view, "bold", "_al|pha_", { active: true });
  });
  useSpec("___al|pha___", {}, (view) => {
    expectFormat(view, "italic", "__al|pha__", { active: true });
  });
});

test("empty, partial, mixed, and literal emphasis is refused without a history entry", () => {
  const cases = [
    ["|", "bold", emptyReason("bold")],
    ["   |  ", "italic", emptyReason("italic")],
    ["alpha  |  beta", "bold", emptyReason("bold")],
    ["Note:|", "bold", emptyReason("bold")],
    ["[[   ]]", "italic", emptyReason("italic")],
    ["[[Note:]]text", "bold", literalReason("bold")],
    ["[[Note:]]text", "italic", literalReason("italic")],
    ["**al[[ph]]a**", "bold", PARTIAL],
    ["**alpha *b[[et]]a* gamma**", "bold", PARTIAL],
    ["|.|", "bold", emptyReason("bold")],
    ["[[plain **bold**]]", "bold", MIXED],
    ["[[**a** **b**]]", "bold", MIXED],
    ["[[alpha\n\nbeta]]", "bold", CROSS],
    ["[[alpha\nbeta]]", "bold", MULTILINE],
    ["[[# Title]]", "bold", MARKER],
    ["[[#]] Title", "bold", MARKER],
    ["Title\n[[=====]]", "bold", MARKER],
  ];
  for (const [spec, command, reason] of cases) {
    useSpec(spec, {}, (view) => expectRefusal(view, command, reason));
  }
});

test("multiple ranges and composition refuse without falling through to an edit", () => {
  withView("alpha beta", EditorSelection.create([
    EditorSelection.cursor(1),
    EditorSelection.cursor(7),
  ]), {}, (view) => {
    expectRefusal(view, "bold", MULTI);
    expectRefusal(view, "italic", MULTI);
  });

  useSpec("al|pha", {}, (view) => {
    Object.defineProperty(view, "composing", { configurable: true, get: () => true });
    expectRefusal(view, "bold", COMPOSITION);
    expectRefusal(view, "italic", COMPOSITION);
  });
});

test("a read-only document and a missing parse tree refuse without guessing", () => {
  useSpec("al|pha", { readOnly: true }, (view) => {
    expectRefusal(view, "bold", READ_ONLY);
  });
  useSpec("al|pha", { markdown: false }, (view) => {
    expectRefusal(view, "italic", LOADING);
  });
});

test("code, HTML, tables, links, and heading markers block the whole selection", () => {
  const cases = [
    ["use [[`code`]] here", CODE],
    ["[[use `code` here]]", CODE],
    ["```\n[[code]]\n```\n\nafter", CODE],
    ["    [[code]]\n\nafter", CODE],
    ["<div>[[x]]</div>", HTML],
    ["| a |\n| - |\n| [[c]] |", TABLE],
    ["[la|bel](https://example.com)", LINK],
    ["see <https://exa|mple.com> now", LINK],
    ["![a|lt](img.png) word", LINK],
    ["before [[use `code`]]", CODE],
    ["[[see [label](url) now]]", LINK],
  ];
  for (const [spec, reason] of cases) {
    useSpec(spec, {}, (view) => expectRefusal(view, "bold", reason));
  }

  useSpec("use `code` [[here]]", {}, (view) => {
    expectFormat(view, "bold", "use `code` **[[here]]**");
  });
  useSpec("![alt](img.png) [[word]]", {}, (view) => {
    expectFormat(view, "italic", "![alt](img.png) *[[word]]*");
  });
});

test("frontmatter is protected regardless of YAML validity, BOM, or CR lines", () => {
  const protectedCases = [
    "---\n[[title]]: x\n---\nBody",
    "---\n[[---]]\nBody",
    "---\n[[: bad]]\n---\nBody",
    "---\njust [[scalar]]\n---\nBody",
    "\uFEFF---\n[[title]]: x\n---\nBody",
    "---\ntitle: x\n...\n[[Body]]",
    "---\ntitle: x\n[[Body]]",
  ];
  for (const spec of protectedCases) {
    useSpec(spec, {}, (view) => expectRefusal(view, "bold", METADATA));
  }

  useSpec("---\ntitle: x\n---\n[[Body]]", {}, (view) => {
    expectFormat(view, "bold", "---\ntitle: x\n---\n**[[Body]]**");
  });
  useSpec("---\n---\n[[Body]]", {}, (view) => {
    expectFormat(view, "italic", "---\n---\n*[[Body]]*");
  });
  useSpec("---\n: bad\n---\n[[Body]]", {}, (view) => {
    expectFormat(view, "bold", "---\n: bad\n---\n**[[Body]]**");
  });
  useSpec("\uFEFF---\ntitle: x\n---\n[[Body]]", {}, (view) => {
    expectFormat(view, "bold", "\uFEFF---\ntitle: x\n---\n**[[Body]]**");
  });

  const crDoc = "---\rtitle: x\r---\rBody";
  withView(crDoc, EditorSelection.cursor(0), { lineSeparator: "\r" }, (view) => {
    assert.equal(view.state.lineBreak, "\r");
    const text = view.state.doc.toString();
    const title = text.indexOf("title");
    const body = text.indexOf("Body");
    assert.equal(body, text.indexOf("\nBody") + 1);
    view.dispatch({ selection: EditorSelection.single(title, title + "title".length) });
    expectRefusal(view, "bold", METADATA);
    view.dispatch({ selection: EditorSelection.single(body, body + "Body".length) });
    const result = applyEmphasisCommand(view, "bold");
    assert.equal(result.applied, true);
    assert.equal(view.state.sliceDoc(), "---\rtitle: x\r---\r**Body**");
    assert.equal(selected(view), "Body");
  });
});

test("math uses the two-or-more-dollar dialect and leaves currency usable", () => {
  const protectedMath = [
    "See [[$$x$$]] now",
    "See $$[[x]]$$ now",
    "[[$$$x$$$]]",
    "$$\n\n[[x]]\n\n$$",
    "$$\n[[x]]",
    "[[$$]]",
    "- $$[[x]]$$",
    "> $$[[x]]$$",
    "[[$$unclosed]]",
    "\uFEFFhello $$[[ab]]$$",
    "> $$\n> [[x]]\n> $$",
    "- $$\n  [[x]]\n  $$",
  ];
  for (const spec of protectedMath) {
    useSpec(spec, {}, (view) => expectRefusal(view, "bold", MATH));
  }

  const allowed = [
    ["[[$150]] to $250", "**[[$150]]** to $250"],
    ["a $$ [[foo]]", "a $$ **[[foo]]**"],
    ["[[$x$]]", "**[[$x$]]**"],
    ["`$$x$$` and [[word]]", "`$$x$$` and **[[word]]**"],
    ["```\n$$\nx\n$$\n```\n\n[[word]]", "```\n$$\nx\n$$\n```\n\n**[[word]]**"],
    ["- [[item]]", "- **[[item]]**"],
    ["> [[hello]]", "> **[[hello]]**"],
    ["\uFEFF[[hello]] $$ab$$", "\uFEFF**[[hello]]** $$ab$$"],
    ["before\n\n$$\nx\n$$\n\n[[after]]", "before\n\n$$\nx\n$$\n\n**[[after]]**"],
  ];
  for (const [spec, expected] of allowed) {
    useSpec(spec, {}, (view) => expectFormat(view, "bold", expected));
  }
});

test("uniform CRLF positions stay document positions and slice back to CRLF", () => {
  withView("alpha\r\nbeta", EditorSelection.cursor(0), { lineSeparator: "\r\n" }, (view) => {
    assert.equal(view.state.lineBreak, "\r\n");
    const beta = view.state.doc.toString().indexOf("beta");
    assert.equal(beta, 6);
    view.dispatch({ selection: EditorSelection.cursor(beta + 2) });
    const result = applyEmphasisCommand(view, "italic");
    assert.equal(result.applied, true);
    assert.equal(view.state.sliceDoc(), "alpha\r\n*be|ta*".replace("|", ""));
    assert.equal(view.state.selection.main.head, "*be|ta*".indexOf("|") + beta);
    assert.equal(view.state.lineBreak, "\r\n");
  });
});

test("one undo reverses only the emphasis and redo restores it", () => {
  useSpec("al|pha", {}, (view) => {
    view.dispatch({
      changes: { from: 0, insert: "Q " },
      selection: EditorSelection.cursor(4),
      userEvent: "input",
    });
    const bolded = applyEmphasisCommand(view, "bold");
    assert.equal(bolded.applied, true);
    assert.equal(view.state.sliceDoc(), "Q **alpha**");
    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: "Z" },
      userEvent: "input",
    });
    assert.equal(view.state.sliceDoc(), "Q **alZpha**");

    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "Q **alpha**");
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "Q alpha");
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "alpha");

    assert.equal(redo(view), true);
    assert.equal(view.state.sliceDoc(), "Q alpha");
    assert.equal(redo(view), true);
    assert.equal(view.state.sliceDoc(), "Q **alpha**");
    assert.equal(redo(view), true);
    assert.equal(view.state.sliceDoc(), "Q **alZpha**");
  });
});

test("a second emphasis command toggles the same words back off", () => {
  useSpec("[[alpha]]", {}, (view) => {
    expectFormat(view, "bold", "**[[alpha]]**");
    expectFormat(view, "bold", "[[alpha]]", { active: true });
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "**alpha**");
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "alpha");
  });
});

test("Unicode words and explicitly selected emoji stay intact", () => {
  const word = "cafe\u0301";
  withView(word, EditorSelection.cursor(0), {}, (view) => {
    expectFormat(view, "bold", `**|${word}**`);
  });

  const emoji = "😀";
  withView(emoji, EditorSelection.cursor(0), {}, (view) => {
    expectRefusal(view, "bold", emptyReason("bold"));
  });
  withView(emoji, EditorSelection.single(0, emoji.length), {}, (view) => {
    const result = applyEmphasisCommand(view, "italic");
    assert.equal(result.applied, true);
    assert.equal(view.state.sliceDoc(), `*${emoji}*`);
    assert.equal(selected(view), emoji);
  });
});

test("actual command output renders difficult emphasis boundaries with the reader", async () => {
  const samples = [
    ["[[alpha]]", "bold", "<p><strong>alpha</strong></p>"],
    ["[[alpha]]", "italic", "<p><em>alpha</em></p>"],
    ["*[[alpha]]*", "bold", "<p><em><strong>alpha</strong></em></p>"],
    ["[[Note:]] text", "bold", "<p><strong>Note:</strong> text</p>"],
    ["[[.]]", "bold", "<p><strong>.</strong></p>"],
    ["[[😀]]", "bold", "<p><strong>😀</strong></p>"],
    ["_[[alpha]]_", "bold", "<p><em><strong>alpha</strong></em></p>"],
    ["**alpha *be|ta* gamma**", "bold", "<p>alpha <em>beta</em> gamma</p>"],
    ["**alpha *be|ta* gamma**", "italic", "<p><strong>alpha beta gamma</strong></p>"],
    ["***al|pha***", "bold", "<p><em>alpha</em></p>"],
    ["***al|pha***", "italic", "<p><strong>alpha</strong></p>"],
  ];
  for (const [spec, command, expected] of samples) {
    const source = useSpec(spec, {}, (view) => {
      assert.equal(applyEmphasisCommand(view, command).applied, true, spec);
      return view.state.sliceDoc();
    });
    assert.equal(await readerHtml(source), expected, spec);
  }
});

test("availability and execution share one refusal for an unfinished context", () => {
  // Pause the actual Markdown parser after its first block, independent of CPU
  // speed. Still honor stopAt so CodeMirror can obtain a valid partial tree.
  let released = false;
  const parser = commonmarkParser.configure([GFM, { wrap(inner) {
    let finishing = false;
    return {
      advance() { return released || finishing || inner.parsedPos < 5 ? inner.advance() : null; },
      get parsedPos() { return inner.parsedPos; },
      get stoppedAt() { return inner.stoppedAt; },
      stopAt(pos) {
        inner.stopAt(pos);
        if (pos <= inner.parsedPos) finishing = true;
      },
    };
  } }]);
  const language = new Language(commonmarkLanguage.data, parser);
  const doc = `first\n\n${"plain paragraph\n\n".repeat(300)}tail`;
  withView(doc, EditorSelection.cursor(doc.length - 2), { language, parse: false }, (view) => {
    assert.equal(syntaxTreeAvailable(view.state, doc.length), false);
    assert.ok(syntaxTree(view.state).length > 0, "fixture contains real parsed Markdown");
    assert.ok(syntaxTree(view.state).length < doc.length, "fixture is incomplete");
    expectRefusal(view, "bold", LOADING);
    expectRefusal(view, "italic", LOADING);
    released = true;
    assert.equal(forceParsing(view, doc.length, 2000), true);
    assert.equal(syntaxTreeAvailable(view.state, doc.length), true);
    assert.equal(applyEmphasisCommand(view, "bold").applied, true);
    assert.ok(view.state.sliceDoc().endsWith("**tail**"));
  });
});

test("successive status queries use parse progress beyond the state's original tree", () => {
  const prefix = "ordinary paragraph\n\n".repeat(400);
  const doc = `${prefix}alpha beta\n\nmore text`;
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(prefix.length + 2),
    extensions: [markdownFormattingExtensions(true)],
  });
  const snapshotLength = syntaxTree(state).length;
  assert.ok(snapshotLength < prefix.length, "fixture starts with a partial snapshot");
  for (const command of ["bold", "italic", "bold"]) {
    assert.deepEqual(emphasisCommandStatus(state, command), { available: true, active: false, reason: null });
  }
  assert.equal(syntaxTree(state).length, snapshotLength, "background progress does not replace the state snapshot");
  assert.equal(syntaxTreeAvailable(state, prefix.length + "alpha beta\n".length), true, "the mutable parser context has advanced");
  const view = new EditorView({ state });
  try {
    assert.equal(applyEmphasisCommand(view, "italic").applied, true);
    assert.equal(view.state.sliceDoc(), `${prefix}*alpha* beta\n\nmore text`);
  } finally { view.destroy(); }
});

test("emphasis preserves touching inline syntax and enclosing strikethrough", async () => {
  const cases = [
    "~~old [[text]]~~",
    "[[~~old~~ text]]",
    "[[word]]`code`",
    "`code`[[word]]",
    "say [[hi]]\\!",
    "\\![[hi]]",
    "[[see]][link](url)",
    "[link](url)[[see]]",
    "Foot[[note]][^1]\n\n[^1]: A footnote.",
    "a [[b]]<br>",
    "<br>[[text]]",
  ];
  for (const spec of cases) {
    for (const command of ["bold", "italic"]) {
      const marker = command === "bold" ? "**" : "*";
      const source = useSpec(spec, {}, (view) => {
        expectFormat(view, command, spec.replace("[[", `${marker}[[`).replace("]]", `]]${marker}`));
        return view.state.sliceDoc();
      });
      const html = await readerHtml(source);
      assert.ok(html.includes(command === "bold" ? "<strong>" : "<em>"), spec);
      assert.equal(html.replace(/<\/?(?:strong|em)>/g, ""), await readerHtml(notation(spec).doc), spec);
    }
  }
});

test("removing emphasis refuses changes to adjacent formatting and block structure", async () => {
  const cases = [
    ["**al|pha**_beta_", "bold"],
    ["_alpha_**be|ta**", "bold"],
    ["*al|pha*__beta__", "italic"],
    ["**- it|em**", "bold"],
    ["**# Ti|tle**", "bold"],
    ["**--|-**", "bold"],
    ["**> qu|ote**", "bold"],
    ["**1. it|em**", "bold"],
    ["- **[ ] ta|sk**", "bold"],
    ["[[**---**]]", "bold"],
    ["**[[$]]**$x$$", "bold"],
    ["[[$]]$$alpha$$", "bold"],
  ];
  for (const [spec, command] of cases) {
    const source = useSpec(spec, {}, (view) => {
      if (emphasisCommandStatus(view.state, command).available) {
        assert.equal(expectReaderRefusal(view, command), null);
      } else expectRefusal(view, command, CHANGED_SYNTAX);
      return view.state.sliceDoc();
    });
    assert.equal(await readerHtml(source), await readerHtml(notation(spec).doc), spec);
  }
});

test("a caret-expanded toggle rechecks protected descendants and multiline boundaries", () => {
  const cases = [
    ["**al|pha $$x$$ beta**", MATH],
    ["**al|pha `code` beta**", CODE],
    ["**al|pha [link](url) beta**", LINK],
    ["**al|pha <i>x</i> beta**", HTML],
    ["**al|pha\nbeta**", MULTILINE],
  ];
  for (const [spec, reason] of cases) useSpec(spec, {}, (view) => expectRefusal(view, "bold", reason));
  useSpec("[[*alpha\nbeta*]]", {}, (view) => expectRefusal(view, "bold", MULTILINE));
});

test("existing checklist text supports emphasis while the checkbox stays protected", async () => {
  for (const prefix of ["- [ ] ", "- [x] ", "- [X] ", "- parent\n  - [ ] "]) {
    for (const command of ["bold", "italic"]) {
      const marker = command === "bold" ? "**" : "*";
      const source = useSpec(`${prefix}[[alpha]]`, {}, (view) => {
        expectFormat(view, command, `${prefix}${marker}[[alpha]]${marker}`);
        const formatted = view.state.sliceDoc();
        assert.equal(undo(view), true);
        assert.equal(view.state.sliceDoc(), `${prefix}alpha`);
        assert.equal(redo(view), true);
        assert.equal(view.state.sliceDoc(), formatted);
        return formatted;
      });
      const html = await readerHtml(source);
      assert.match(html, /type="checkbox"/);
      assert.ok(html.includes(command === "bold" ? "<strong>alpha</strong>" : "<em>alpha</em>"));
    }
  }
  useSpec("- [x] al|pha", {}, (view) => expectFormat(view, "italic", "- [x] *al|pha*"));
  useSpec("- [ ] **al|pha**", {}, (view) => expectFormat(view, "bold", "- [ ] al|pha", { active: true }));
  for (const selection of [EditorSelection.cursor(3), EditorSelection.single(3, 4), EditorSelection.single(2, 11)]) {
    withView("- [x] alpha", selection, {}, (view) => expectRefusal(view, "bold", CHECKBOX));
  }
  useSpec("- [ ] al|pha $$x$$", {}, (view) => expectFormat(view, "bold", "- [ ] **al|pha** $$x$$"));
  useSpec("- [ ] [[alpha `code`]]", {}, (view) => expectRefusal(view, "bold", CODE));
});

test("availability reuses math scans by document identity and incremental Markdown fragments", (t) => {
  // Deliberate work-count guard for the measured repeated-parsing regression;
  // avoid flaky wall-clock thresholds. Revisit these spies on parser upgrades.
  const { unified } = require("unified");
  const mathParse = t.mock.method(Object.getPrototypeOf(unified()), "parse");
  const doc = `alpha beta\n\n${"ordinary paragraph\n\n".repeat(100)}$$x$$`;
  withView(doc, EditorSelection.cursor(2), {}, (view) => {
    const fullParse = t.mock.method(markdownGfmParser, "parse");
    const incremental = t.mock.method(markdownGfmParser, "createParse");
    for (const pos of [2, 7, 3]) {
      view.dispatch({ selection: EditorSelection.cursor(pos) });
      for (const command of ["bold", "italic"]) {
        assert.equal(emphasisCommandStatus(view.state, command).available, true);
      }
    }
    assert.equal(mathParse.mock.callCount(), 1, "selection/status queries share one math parse");
    assert.equal(fullParse.mock.callCount(), 0, "no standalone full-document candidate parse");
    assert.ok(incremental.mock.calls.length > 0);
    assert.ok(incremental.mock.calls.every((call) => call.arguments[1].length > 0), "candidate parses reuse fragments");
    assert.equal(applyEmphasisCommand(view, "bold").applied, true);
    assert.equal(mathParse.mock.callCount(), 2, "Apply reuses the baseline and parses only the candidate");
    emphasisCommandStatus(view.state, "bold");
    assert.equal(mathParse.mock.callCount(), 2, "accepted formatting retains its validated candidate");
    view.dispatch({ changes: { from: view.state.doc.length, insert: " " } });
    emphasisCommandStatus(view.state, "bold");
    assert.equal(mathParse.mock.callCount(), 3, "ordinary typing invalidates the scan");

    const replacement = "alpha $$secret$$";
    view.setState(EditorState.create({
      doc: replacement,
      selection: EditorSelection.cursor(replacement.indexOf("secret") + 1),
      extensions: [history(), markdownFormattingExtensions(true)],
    }));
    expectRefusal(view, "bold", MATH);
    assert.equal(mathParse.mock.callCount(), 4, "external replacement cannot reuse stale ranges");
  });
});

// Apply is authoritative for reader-only conflicts; preliminary status may be
// optimistic. Every refusal must consume the command without dispatching.
function expectReaderRefusal(view, command) {
  const state = view.state;
  let dispatches = 0;
  const dispatch = view.dispatch;
  view.dispatch = (...args) => { dispatches++; return dispatch(...args); };
  let result;
  try { result = applyEmphasisCommand(view, command); }
  finally { view.dispatch = dispatch; }
  if (result.applied) return { source: state.sliceDoc(), command, output: view.state.sliceDoc() };
  assert.equal(result.handled, true);
  assert.equal(result.available, false);
  assert.equal(result.reason, CHANGED_SYNTAX);
  assert.equal(dispatches, 0, 'no transaction/publication on refusal');
  assert.equal(view.state, state, 'document, selection and history retain identity');
  assert.equal(undoDepth(view.state), undoDepth(state));
  assert.equal(redoDepth(view.state), redoDepth(state));
  return null;
}

test('reader conflicts in host-adjacent URL suffixes and glued emails refuse both styles atomically', async () => {
  const failures = [];
  const specs = [
    'www.ex.com$$[[x]]$$.',
    'https://ex.com?[[x]]=1',
    'https://ex.com#[[x]]',
    'www.ex.com+[[x]]',
    'www.ex.coma@b.co[[x]]',
  ];
  for (const spec of specs) for (const command of ['bold', 'italic']) {
    const parsed = notation(spec);
    for (const mode of ['selection', 'reversed', 'caret']) {
      const { from, to } = parsed.selection.main;
      const selection = mode === 'caret' ? EditorSelection.cursor(from)
        : mode === 'reversed' ? EditorSelection.single(to, from) : parsed.selection;
      const output = withView(parsed.doc, selection, {}, (view) => {
        const failure = expectReaderRefusal(view, command);
        if (failure) failures.push({ ...failure, mode });
        return view.state.sliceDoc();
      });
      if (output === parsed.doc) assert.equal(await readerHtml(output), await readerHtml(parsed.doc));
    }
  }
  assert.deepEqual(failures, [], 'actual command outputs that should have refused');
});

test('removing either style inside reader-only URLs refuses atomically', () => {
  const failures = [];
  for (const command of ['bold', 'italic']) {
    const m = command === 'bold' ? '**' : '*';
    for (const spec of [
      `www.ex.com?${m}[[x]]${m}=1`,
      `https://ex.com#${m}[[x]]${m}`,
      `www.ex.com+${m}[[x]]${m}`,
      `www.ex.com$$${m}[[x]]${m}$$.`,
    ]) for (const caret of [false, true]) {
      useSpec(caret ? spec.replace('[[x]]', '|x') : spec, {}, (view) => {
        const failure = expectReaderRefusal(view, command);
        if (failure) failures.push(failure);
      });
    }
  }
  assert.deepEqual(failures, []);
});

test('ASCII tilde attention and Unicode boundary conflicts cannot redirect emphasis', () => {
  const failures = [];
  for (const [spec, command] of [
    ['x**z~~[[a]]b', 'bold'],
    ['*z~~[[a]]b', 'italic'],
    ['**z~[[a]]b', 'bold'],
    ['£&amp;**😀~~[[a]]😀', 'bold'],
  ]) useSpec(spec, {}, (view) => {
    const failure = expectReaderRefusal(view, command);
    if (failure) failures.push(failure);
  });
  assert.deepEqual(failures, []);
});

test('removing a wrapper cannot expose math fences that consume following prose', () => {
  const failures = [];
  for (const m of ['**', '*']) for (const ending of ['', '\n\n$$']) {
    for (const content of ['[[$$]]', '$|$']) {
      useSpec(`${m}${content}${m}\n\nword${ending}`, {}, (view) => {
        const failure = expectReaderRefusal(view, m === '**' ? 'bold' : 'italic');
        if (failure) failures.push(failure);
      });
    }
  }
  useSpec('**$$ |x**\nword\n$$', {}, (view) => {
    const failure = expectReaderRefusal(view, 'bold');
    if (failure) failures.push(failure);
  });
  assert.deepEqual(failures, []);
});

test('dollar joins and splits remain safe after replacing the dollar-neighbor guard', () => {
  for (const [spec, command] of [
    ['**[[$]]**$x$$', 'bold'], ['*[[$]]*$x$$', 'italic'],
    ['[[$]]$$alpha$$', 'bold'], ['[[$]]$$alpha$$', 'italic'],
  ]) useSpec(spec, {}, (view) => assert.equal(expectReaderRefusal(view, command), null));
});

test('URLs with a path already refuse through the shared link guard', () => {
  for (const spec of ['https://ex.com/?[[x]]=1', 'https://ex.com/page#[[x]]',
    'https://www.youtube.com/watch?v=[[abc]]', 'x [a[[b]]c] y\n\n[abc]: /u']) {
    for (const command of ['bold', 'italic']) useSpec(spec, {}, (view) => expectRefusal(view, command, LINK));
  }
});

test('reader comparison preserves exact style coverage, repeated words and surrounding semantics', async () => {
  const cases = [
    ['*[[alpha]]* and **alpha**', 'bold', '***alpha*** and **alpha**', '<p><em><strong>alpha</strong></em> and <strong>alpha</strong></p>'],
    ['**one *tw|o* three** and *two*', 'bold', 'one *two* three and *two*', '<p>one <em>two</em> three and <em>two</em></p>'],
    ['**one *tw|o* three** and *two*', 'italic', '**one two three** and *two*', '<p><strong>one two three</strong> and <em>two</em></p>'],
    ['***&amp; |😀***', 'bold', '*&amp; 😀*', '<p><em>&amp; 😀</em></p>'],
    ['***&amp; |😀***', 'italic', '**&amp; 😀**', '<p><strong>&amp; 😀</strong></p>'],
    ['&amp; [[café 😀]] &copy;', 'bold', '&amp; **café 😀** &copy;', '<p>&amp; <strong>café 😀</strong> ©</p>'],
    ['alpha [[alpha]] alpha **alpha** *alpha*', 'bold', 'alpha **alpha** alpha **alpha** *alpha*', '<p>alpha <strong>alpha</strong> alpha <strong>alpha</strong> <em>alpha</em></p>'],
  ];
  for (const [spec, command, expected, html] of cases) {
    const output = useSpec(spec, {}, (view) => {
      assert.equal(applyEmphasisCommand(view, command).applied, true, spec);
      assert.equal(view.state.sliceDoc(), expected);
      return view.state.sliceDoc();
    });
    assert.equal(await readerHtml(output), html);
  }
  useSpec('&am[[p]];', {}, (view) => assert.equal(expectReaderRefusal(view, 'bold'), null));
});

test('full-document reference context and ordinary link, image, code and math neighbors survive', async () => {
  for (const definitionsFirst of [false, true]) for (const command of ['bold', 'italic']) {
    const definitions = '[r]: https://ex.com?x=1 "Reference title"\n\n[^n]: footnote *style*\n\n';
    const paragraph = 'word [label][r] [[word]] [explicit](https://ex.com#x "Title") https://ex.com/path?x=1 ![alt](img.png "Image") `code` ~~strike~~ $$x+y$$ [^n]';
    const spec = definitionsFirst ? definitions + paragraph : paragraph + '\n\n' + definitions;
    const original = notation(spec).doc;
    const output = useSpec(spec, {}, (view) => {
      const marker = command === 'bold' ? '**' : '*';
      expectFormat(view, command, spec.replace('[[word]]', `${marker}[[word]]${marker}`));
      const formatted = view.state.sliceDoc();
      expectFormat(view, command, spec, { active: true });
      assert.equal(view.state.sliceDoc(), original);
      assert.equal(undo(view), true);
      assert.equal(view.state.sliceDoc(), formatted);
      assert.equal(redo(view), true);
      assert.equal(view.state.sliceDoc(), original);
      return formatted;
    });
    const html = await readerHtml(output);
    assert.match(html, /href="https:\/\/ex.com\?x=1" title="Reference title"/);
    assert.match(html, /href="https:\/\/ex.com#x" title="Title"/);
    assert.match(html, /src="img.png" alt="alt" title="Image"/);
    // There is no pre-existing strong/emphasis in the main paragraph except
    // footnote style, which must stay intact as well.
    const tag = command === 'bold' ? 'strong' : 'em';
    assert.equal(html.replace(`<${tag}>word</${tag}>`, 'word'), await readerHtml(original));
  }
});

test('reader extraction, BOM and serialized CRLF keep target offsets and following body semantics', async () => {
  const prefixes = [
    '', '\uFEFF',
    '---\ntitle: Notes\n---\n', '\uFEFF---\ntitle: Notes\n---\n',
    '---\n---\n', '---\njust scalar\n---\n', '---\n: bad\n---\n',
    // After valid frontmatter extraction, the reader recognizes this second
    // block as frontmatter too. Parsing the whole original source differs.
    '---\ntitle: Notes\n---\n---\nsecond: hidden\n---\n',
  ];
  for (const prefix of prefixes) for (const lineSeparator of ['\n', '\r\n', '\r']) {
    const source = `${prefix}word\n\nnext *style* $$x$$`.replaceAll('\n', lineSeparator);
    for (const command of ['bold', 'italic']) {
      const output = withView(source, EditorSelection.cursor(0), { lineSeparator }, (view) => {
        const pos = view.state.doc.toString().indexOf('word');
        view.dispatch({ selection: EditorSelection.single(pos + 4, pos) });
        assert.equal(applyEmphasisCommand(view, command).applied, true, JSON.stringify(source));
        const marker = command === 'bold' ? '**' : '*';
        assert.equal(view.state.sliceDoc(), source.replace('word', `${marker}word${marker}`));
        assert.equal(selected(view), 'word');
        assert.ok(view.state.selection.main.anchor > view.state.selection.main.head);
        const formatted = view.state.sliceDoc();
        assert.equal(applyEmphasisCommand(view, command).applied, true);
        assert.equal(view.state.sliceDoc(), source);
        assert.equal(undo(view), true);
        assert.equal(view.state.sliceDoc(), formatted);
        assert.equal(redo(view), true);
        assert.equal(view.state.sliceDoc(), source);
        return formatted;
      });
      const tag = command === 'bold' ? 'strong' : 'em';
      assert.equal((await readerHtml(output)).replace(`<${tag}>word</${tag}>`, 'word'), await readerHtml(source));
    }
  }
});

test('a long dense outline keeps working beyond an 8k container', () => {
  const source = '# Study outline\n\n' + Array.from({ length: 200 }, (_, i) =>
    `- Topic ${i}: **evidence** and *reasoning* [reference][r]\n  - [x] Review ~~old~~ observations with detail\n    - Find the important word\n`).join('') + '\n[r]: https://ex.com/path?q=1 "Source"\n';
  assert.ok(source.length > 24000);
  const pos = source.lastIndexOf('important');
  for (const command of ['bold', 'italic']) withView(source, EditorSelection.cursor(pos + 2), {}, (view) => {
    const marker = command === 'bold' ? '**' : '*';
    const expected = source.slice(0, pos) + marker + 'important' + marker + source.slice(pos + 9);
    assert.equal(applyEmphasisCommand(view, command).applied, true);
    assert.equal(view.state.sliceDoc(), expected);
    assert.equal(view.state.selection.main.head, pos + marker.length + 2);
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), source);
  });
});

test('dash and ellipsis presentation changes are intentionally accepted', async () => {
  for (const [spec, expected, oldText] of [
    ['a -[[-]] b', 'a -**-** b', 'a — b'],
    ['a .[[.]]. b', 'a .**.**. b', 'a … b'],
  ]) {
    const original = notation(spec).doc;
    const output = useSpec(spec, {}, (view) => {
      assert.equal(applyEmphasisCommand(view, 'bold').applied, true);
      assert.equal(view.state.sliceDoc(), expected);
      return view.state.sliceDoc();
    });
    assert.equal(await readerHtml(original), `<p>${oldText}</p>`);
    assert.equal(await readerHtml(output), `<p>${expected.replace('**', '<strong>').replace('**', '</strong>')}</p>`);
  }
});

test('non-math status never parses the reader; Apply shares immutable baselines without modifying them', (t) => {
  const { unified } = require('unified');
  const proto = Object.getPrototypeOf(unified());
  const parse = proto.parse;
  const trees = [];
  function freeze(value) {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  }
  const spy = t.mock.method(proto, 'parse', function(...args) {
    const tree = freeze(parse.apply(this, args));
    trees.push({ tree, json: JSON.stringify(tree) });
    return tree;
  });
  useSpec('https://ex.com?[[x]]=1', {}, (view) => {
    for (let i = 0; i < 3; i++) for (const command of ['bold', 'italic']) {
      assert.deepEqual(emphasisCommandStatus(view.state, command), { available: true, active: false, reason: null });
    }
    assert.equal(spy.mock.callCount(), 0);
    assert.equal(expectReaderRefusal(view, 'bold'), null);
    assert.equal(spy.mock.callCount(), 2);
    assert.equal(expectReaderRefusal(view, 'italic'), null);
    assert.equal(spy.mock.callCount(), 3, 'one candidate parse per repeated Apply');
    const x = view.state.doc.toString().indexOf('?x') + 1;
    view.dispatch({ changes: { from: x, to: x + 1, insert: 'y' }, selection: EditorSelection.single(x, x + 1) });
    emphasisCommandStatus(view.state, 'bold');
    assert.equal(spy.mock.callCount(), 3);
    assert.equal(expectReaderRefusal(view, 'bold'), null);
    assert.equal(spy.mock.callCount(), 5, 'edit invalidates baseline');
    view.setState(EditorState.create({ doc: 'https://ex.com#z', selection: EditorSelection.single(15, 16), extensions: [history(), markdownFormattingExtensions(true)] }));
    assert.equal(expectReaderRefusal(view, 'bold'), null);
    assert.equal(spy.mock.callCount(), 7, 'external adoption invalidates baseline');
    for (const { tree, json } of trees) assert.equal(JSON.stringify(tree), json);
  });
});

test('reader-body frontmatter cannot be formatted as a visible editor heading', async () => {
  const spec = '---\ntitle: Notes\n---\n---\nsecond: [[word]]\n---\n\nvisible word';
  const original = notation(spec).doc;
  assert.equal(await readerHtml(original), '<p>visible word</p>');
  for (const command of ['bold', 'italic']) useSpec(spec, {}, (view) => {
    assert.equal(emphasisCommandStatus(view.state, command).available, true);
    assert.equal(expectReaderRefusal(view, command), null);
  });
});

test('Apply reuses existing document safety ceilings without introducing a small note cutoff', (t) => {
  const { MARKDOWN_MAX_SOURCE_CODE_UNITS } = require('../.tmp/workspace-tests/src/lib/document-complexity.js');
  const { unified } = require('unified');
  const spy = t.mock.method(Object.getPrototypeOf(unified()), 'parse');
  const source = 'word\n\n```\n' + 'a'.repeat(MARKDOWN_MAX_SOURCE_CODE_UNITS) + '\n```';
  withView(source, EditorSelection.single(0, 4), {}, (view) => {
    const state = view.state;
    const result = applyEmphasisCommand(view, 'bold');
    assert.equal(result.applied, false);
    assert.equal(result.handled, true);
    assert.equal(result.reason, 'This document is too large or complex to format safely. Edit the markers directly.');
    assert.equal(view.state, state);
    assert.equal(spy.mock.callCount(), 0, 'oversized input never reaches the reader parser');
  });
});

test('accepted emphasis retains its validated reader tree for the next command but edits invalidate it', (t) => {
  const { unified } = require('unified');
  const proto = Object.getPrototypeOf(unified());
  const parse = t.mock.method(proto, 'parse');
  useSpec('[[word]]\n\nThe relation is $$x^2$$.', {}, (view) => {
    assert.equal(applyEmphasisCommand(view, 'bold').applied, true);
    assert.equal(parse.mock.callCount(), 2, 'cold baseline and candidate');
    assert.equal(applyEmphasisCommand(view, 'italic').applied, true);
    assert.equal(view.state.sliceDoc(), '***word***\n\nThe relation is $$x^2$$.');
    assert.equal(parse.mock.callCount(), 3, 'the actual dispatched immutable document reuses its validated tree');
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nUnrelated typing.' }, selection: EditorSelection.cursor(5) });
    assert.equal(applyEmphasisCommand(view, 'italic').applied, true);
    assert.equal(parse.mock.callCount(), 5, 'ordinary typing needs both fresh parses');
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), '***word***\n\nThe relation is $$x^2$$.\nUnrelated typing.');
    assert.equal(redo(view), true);
    assert.equal(view.state.sliceDoc(), '**word**\n\nThe relation is $$x^2$$.\nUnrelated typing.');
  });
});

test('reader cache distinguishes the same immutable text serialized with different line breaks', (t) => {
  const { Text } = require('@codemirror/state');
  const { unified } = require('unified');
  const proto = Object.getPrototypeOf(unified());
  const parse = t.mock.method(proto, 'parse');
  const doc = Text.of(['word', '', '$$x^2$$']);
  for (const lineBreak of ['\n', '\r\n', '\r']) {
    withView(doc, EditorSelection.single(0, 4), {
      lineSeparator: lineBreak,
    }, view => {
      assert.equal(applyEmphasisCommand(view, 'bold').applied, true);
      assert.equal(view.state.sliceDoc(), ['**word**', '', '$$x^2$$'].join(lineBreak));
    });
  }
  assert.equal(parse.mock.callCount(), 6, 'each serialization has a fresh baseline and candidate');
});
