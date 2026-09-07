const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { rules } = require("fountain-js");

const {
  FOUNTAIN_ESCAPABLE_CHARACTERS,
  fountainPlainText,
  fountainToSearchableText,
  normalizeCharacterName,
  parseFountain,
  splitFountainInline,
} = require("../.tmp/workspace-tests/src/lib/fountain.js");
const { FountainRenderer } = require("../.tmp/workspace-tests/src/components/FountainRenderer.js");

const readerSettings = {
  fontSize: 18,
  contentWidth: 72,
  lineHeight: 1.6,
  fontFamily: "newsreader",
  paragraphSpacing: "comfortable",
  sceneLensEnabled: true,
  reducedEffects: false,
};

function renderBody(content) {
  return renderToStaticMarkup(
    React.createElement(FountainRenderer, {
      parsed: parseFountain(content),
      settings: readerSettings,
      contentRef: React.createRef(),
    }),
  )
    .replace(/^<article[^>]*>/, "")
    .replace(/<\/article>$/, "");
}

function segments(text) {
  return splitFountainInline(text).map((segment) => {
    const styles = ["bold", "italic", "underline"].filter((style) => segment[style]);
    return styles.length ? `${styles.join("+")}(${segment.text})` : segment.text;
  });
}

test("inline emphasis markers produce styled segments", () => {
  assert.deepEqual(segments("**bold** and *it* and _u_ and ***bi***"), [
    "bold(bold)", " and ", "italic(it)", " and ", "underline(u)", " and ", "bold+italic(bi)",
  ]);
});

test("inline emphasis nests combined markers", () => {
  assert.deepEqual(segments("_**underline bold**_"), ["bold+underline(underline bold)"]);
  assert.deepEqual(segments("*it **bold** it*"), ["italic(it )", "bold+italic(bold)", "italic( it)"]);
});

test("markers inside words, next to spaces, or unmatched stay literal", () => {
  assert.deepEqual(segments("snake_case_name here"), ["snake_case_name here"]);
  assert.deepEqual(segments("5 * 3 * 2 = 30"), ["5 * 3 * 2 = 30"]);
  assert.deepEqual(segments("**unclosed bold"), ["**unclosed bold"]);
  assert.deepEqual(segments("*"), ["*"]);
  assert.deepEqual(segments("a ** b"), ["a ** b"]);
  assert.deepEqual(segments("_leading and trailing_word"), ["_leading and trailing_word"]);
});

test("emphasis respects punctuation and never spans a line break", () => {
  assert.deepEqual(segments("(*beat*), then \"**yes**\"."), ["(", "italic(beat)", "), then \"", "bold(yes)", "\"."]);
  assert.deepEqual(segments("*open\nclose*"), ["*open\nclose*"]);
  assert.deepEqual(segments("*same* line\n**next** line"), ["italic(same)", " line\n", "bold(next)", " line"]);
});

test("backslash escapes the same characters fountain-js escapes", () => {
  assert.deepEqual(segments("\\*not italic\\* and \\_plain\\_ and back\\\\slash"), [
    "*not italic* and _plain_ and back\\slash",
  ]);
  assert.deepEqual(segments("\\q keeps an unknown escape"), ["\\q keeps an unknown escape"]);
  const escape = new RegExp(rules.escape.source);
  for (const char of FOUNTAIN_ESCAPABLE_CHARACTERS) {
    assert.ok(escape.test(`\\${char}`), `fountain-js does not escape \\${char}`);
  }
  const libraryEscapables = rules.escape.source.match(/\[(.*)\]/)[1].replace(/\\(.)/g, "$1");
  assert.equal(new Set(libraryEscapables).size, FOUNTAIN_ESCAPABLE_CHARACTERS.size);
});

test("the reader renders emphasis, escapes, and literal markers the same way search text does", () => {
  const html = renderBody("Use snake_case_name and 2*3, \\*literal\\*, and **bold**.");
  assert.doesNotMatch(html, /text-decoration|<em>/);
  assert.match(html, /snake_case_name and 2\*3, \*literal\*, and <strong>bold<\/strong>\./);
  assert.equal(
    fountainToSearchableText(parseFountain("Use snake_case_name and 2*3, \\*literal\\*, and **bold**.")),
    "Use snake_case_name and 2*3, *literal*, and bold.",
  );
  assert.equal(fountainPlainText("_**x**_ y"), "x y");
});

test("title-page values render emphasis instead of literal markers", () => {
  const html = renderBody("Title: _**BRICK & STEEL**_\nCredit: *Written by*\nAuthor: Stu\n\nINT. X - DAY");
  assert.match(html, /<h1 class="fountain-title"><span style="text-decoration:underline"><strong>BRICK &amp; STEEL<\/strong><\/span><\/h1>/);
  assert.match(html, /<p class="fountain-credit"><em>Written by<\/em><\/p>/);
  assert.doesNotMatch(html, /\*\*|_\*/);
});

test("multi-line action and dialogue keep their line breaks in the rendered text", () => {
  const html = renderBody("The car rolls.\n    It stops.\n\nBOB\nLine one.\nLine two.");
  assert.match(html, /<p class="fountain-action">The car rolls\.\n    It stops\.<\/p>/);
  assert.match(html, /<p class="fountain-dialogue" data-character="BOB">Line one\.\nLine two\.<\/p>/);
});

test("screen CSS preserves line breaks inside Fountain blocks", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "app.css"), "utf8");
  const screen = css.slice(0, css.indexOf("@media print"));
  const rule = screen.match(/\n((?:\.fountain-[\w-]+,\n)*\.fountain-[\w-]+)\s*\{\s*white-space:\s*pre-wrap;\s*\}/);
  assert.ok(rule, "a pre-wrap rule for Fountain blocks exists");
  const selectors = rule[1].split(",").map((selector) => selector.trim());
  for (const selector of [
    ".fountain-action", ".fountain-dialogue", ".fountain-lyrics", ".fountain-centered",
    ".fountain-title", ".fountain-credit", ".fountain-author", ".fountain-draft-date", ".fountain-title-entry",
  ]) {
    assert.ok(selectors.includes(selector), `${selector} keeps line breaks`);
  }
});

test("character extensions are stripped only from the end of the cue", () => {
  assert.equal(normalizeCharacterName("SARAH (CONT’D)"), "SARAH");
  assert.equal(normalizeCharacterName("SARAH (INTO PHONE)"), "SARAH");
  assert.equal(normalizeCharacterName("SARAH (V.O.) (CONT'D)"), "SARAH");
  assert.equal(normalizeCharacterName("sarah (o.s.)"), "SARAH");
  assert.equal(normalizeCharacterName("SARAH (V.O."), "SARAH (V.O.");
  assert.equal(normalizeCharacterName("(V.O.)"), "");
  assert.equal(normalizeCharacterName("BOB (THE ELDER) SMITH"), "BOB (THE ELDER) SMITH");
});

test("extension variants merge into one character for stats and focus", () => {
  const parsed = parseFountain("INT. A - DAY\n\nSARAH\nHi.\n\nSARAH (CONT’D)\nStill me.\n\nSARAH (INTO PHONE)\nHello?");
  const { computeScriptStats } = require("../.tmp/workspace-tests/src/lib/fountain.js");
  assert.deepEqual(computeScriptStats(parsed).characters.map((c) => [c.name, c.dialogueCount]), [["SARAH", 3]]);
  const html = renderBody("SARAH (INTO PHONE)\nHello?");
  assert.match(html, /data-character="SARAH">SARAH \(INTO PHONE\)</);
});

test("dual dialogue renders two columns with speaker attributes and degrades on stray markers", () => {
  const pair = renderBody("BOB\nHi.\n\nCAROL^\n(soft)\nHey.\n\nDAN\nYo.");
  assert.equal(
    pair,
    '<div class="fountain-dual-dialogue">'
      + '<div class="fountain-dual-column"><p class="fountain-character" data-character="BOB">BOB</p><p class="fountain-dialogue" data-character="BOB">Hi.</p></div>'
      + '<div class="fountain-dual-column"><p class="fountain-character" data-character="CAROL">CAROL</p><p class="fountain-parenthetical" data-character="CAROL">(soft)</p><p class="fountain-dialogue" data-character="CAROL">Hey.</p></div>'
      + '</div>'
      + '<p class="fountain-character" data-character="DAN">DAN</p><p class="fountain-dialogue" data-character="DAN">Yo.</p>',
  );
  // A caret with nothing before it has no partner: render the block normally.
  assert.equal(
    renderBody("BOB^\nHi."),
    '<p class="fountain-character" data-character="BOB">BOB</p><p class="fountain-dialogue" data-character="BOB">Hi.</p>',
  );
  // Speaker tagging continues after the pair.
  assert.match(renderBody("A\nOne.\n\nB^\nTwo.\n\nThree.\n\nC\nFour."), /data-character="C">Four\./);
});
