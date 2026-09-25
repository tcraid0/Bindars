const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { Lexer } = require("fountain-js");

const fountainModulePath = require.resolve("../.tmp/workspace-tests/src/lib/fountain.js");
const processingModulePath = require.resolve("../.tmp/workspace-tests/src/lib/document-processing.js");
const { parseFountain, fountainToSearchableText } = require(fountainModulePath);

const { hostileCases, retainedText } = require("./_helpers/fountain-hostile-cases.cjs");

// Child processes let a stuck synchronous parser fail its test instead of the
// suite. The regressions these guard ran for minutes or forever, while a normal
// case takes at most about 1.5 s on CI; shared macOS runners have stalled a
// single child past 8 s, so the limit leaves wide room for that.
const CHILD_PROCESS_LIMIT_MS = 30_000;

for (const [name, source] of Object.entries(hostileCases)) {
  test(`Fountain ${name} finishes preparation, statistics, rendering and workspace indexing`, () => {
    const result = spawnSync(process.execPath, ["--max-old-space-size=1024", "-e", String.raw`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const source = fs.readFileSync(0, 'utf8');
      const { prepareReaderDocument } = require(${JSON.stringify(processingModulePath)});
      const prepared = prepareReaderDocument(source, 'fountain');
      assert.equal(prepared.status, 'ready');
      const parsed = prepared.parsedFountain;
      const parsedText = [...parsed.titlePage.map(entry => entry.value), ...parsed.tokens.map(token => token.text ?? '')].join('\n');
      assert.ok(parsedText.includes(${JSON.stringify(retainedText[name])}), 'Hostile content survives parsing');
      const { computeScriptStats } = require(${JSON.stringify(fountainModulePath)});
      computeScriptStats(parsed);
      if (${name.startsWith("transition")}) {
        assert.deepEqual(prepared.parsedFountain.tokens.map(token => token.type), ['scene_heading', 'action']);
        assert.ok(prepared.parsedFountain.tokens[1].text === source.slice(source.indexOf('\n\n') + 2).replace(/\t/g, '    '),
          'Action text is retained, with the existing four-space tab expansion');
      }
      const React = require('react');
      const { renderToStaticMarkup } = require('react-dom/server');
      const { FountainRenderer } = require(${JSON.stringify(require.resolve("../.tmp/workspace-tests/src/components/FountainRenderer.js"))});
      const html = renderToStaticMarkup(React.createElement(FountainRenderer, {
        parsed: prepared.parsedFountain, contentRef: React.createRef(),
        settings: { fontSize: 18, contentWidth: 72, lineHeight: 1.6, fontFamily: 'newsreader', paragraphSpacing: 'comfortable' },
      }));
      assert.ok(html.length > 0);
      const { tryBuildWorkspaceDoc } = require(${JSON.stringify(require.resolve("../.tmp/workspace-tests/src/lib/workspace-index.js"))});
      const indexed = tryBuildWorkspaceDoc({ path: '/fixture/script.fountain', relPath: 'script.fountain', name: 'script.fountain', mtimeMs: 0, size: source.length }, source);
      assert.equal(indexed.status, 'indexed');
      assert.ok(indexed.doc.bodyText.length > 0, 'Search text is not empty');
      if (${name.startsWith("transition")}) {
        assert.ok(html.includes('bob'));
        assert.equal(indexed.doc.bodyText, source.replace(/\s+/g, ' ').trim());
      }
      process.stdout.write('ok');
    `], { input: source, timeout: CHILD_PROCESS_LIMIT_MS, killSignal: "SIGKILL", encoding: "utf8" });
    assert.equal(result.error, undefined, `${name} exceeded its process limit: ${result.error}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "ok");
  });
}

test("transitions keep special names, forced text and whitespace behavior", () => {
  for (const [source, text] of [
    ["  FADE OUT.  ", "FADE OUT."], ["\tFADE TO BLACK.", "FADE TO BLACK."],
    ["CUT TO BLACK.", "CUT TO BLACK."], [" \tDISSOLVE TO: ", "DISSOLVE TO:"],
    ["  TO:", "TO:"], ["\t TO:", "TO:"], [">  Fade away", "Fade away"],
    [">\tFade away", "Fade away"], ["> ", ""], [">\t", ""],
  ]) {
    assert.deepEqual(parseFountain(source).tokens.map(token => [token.type, token.text]), [["transition", text]], JSON.stringify(source));
  }
  for (const source of [" TO:", "FADE OUT..", "bob TO:nope", "bob TO:\nhi", ">   bob\nhi"]) {
    assert.deepEqual(parseFountain(source).tokens.map(token => [token.type, token.text]), [["action", source]], JSON.stringify(source));
  }
});

test("overlapping boneyard delimiter stays literal", () => {
  for (const source of ["/*/", "foo/*/", "action\n/*/", "hello /*/ there"]) {
    const parsed = parseFountain(source);
    assert.deepEqual(parsed.tokens.map(token => [token.type, token.text]), [["action", source]]);
    assert.equal(fountainToSearchableText(parsed), source.replace(/\s+/g, " "));
  }
  assert.deepEqual(parseFountain("/**/").tokens, []);
  assert.deepEqual(parseFountain("/* */").tokens, []);
  assert.deepEqual(parseFountain("a/*/b*/c").tokens.map(token => [token.type, token.text]), [["action", "ac"]]);
});

test("overlapping boneyard delimiter preserves scene source positions", () => {
  const parsed = parseFountain("INT. A - DAY\n\nEXT. B - NIGHT/*/");
  assert.equal(parsed.scenes[1].text, "EXT. B - NIGHT/*/");
  assert.deepEqual(parsed.scenes.map(scene => scene.source), [
    { line: 1, column: 1 }, { line: 3, column: 1 },
  ]);
});

test("scene headings after two-space lines keep their own source line", () => {
  for (const [source, expected] of [
    ["INT. A - DAY\n\n  \nINT. HOUSE - DAY\n\nBOB\nHi.", { line: 4, column: 1 }],
    ["INT. A - DAY\r\n\r\n  \r\nINT. HOUSE - DAY", { line: 4, column: 1 }],
    ["INT. A - DAY\n\n  \n  \n   .FORCED SCENE", { line: 5, column: 5 }],
    ["  \n  \nEXT. YARD - NIGHT", { line: 3, column: 1 }],
    ["INT. A - DAY\n\n   .FORCED SCENE", { line: 3, column: 5 }],
  ]) {
    assert.deepEqual(parseFountain(source).scenes.at(-1).source, expected, JSON.stringify(source));
  }
});

test("closed comments preserve scene positions and unclosed comments stay literal", () => {
  const parsed = parseFountain("/* hidden\ntext */\n\nINT. A - DAY\n\n/* unclosed /* also unclosed");
  assert.equal(parsed.scenes[0].source.line, 4);
  assert.equal(parsed.tokens.at(-1).text, "/* unclosed /* also unclosed");
  assert.equal(parseFountain("/* first */\n\n/* second */\n\nEXT. B - NIGHT").scenes[0].source.line, 5);
});

test("dialogue keeps forced names, extensions, caret placement and numeric action", () => {
  for (const [cue, name, dual] of [
    ["BOB", "BOB", undefined], ["  @mcCLANE (V.O.) ^  ", "mcCLANE (V.O.)", "right"],
    ["ALICE (CONT'D) (V.O.)", "ALICE (CONT'D) (V.O.)", undefined],
    ["123 (hi) *", "123 (hi) *", undefined], ["BLACK. ", "BLACK.", undefined],
  ]) {
    const parsed = parseFountain(cue + "\n(quietly)\nHello.\n~Singing.");
    assert.equal(parsed.tokens.find((token) => token.type === "character")?.text, name, cue);
    assert.equal(parsed.tokens.find((token) => token.type === "dialogue_begin")?.dual, dual, cue);
    assert.ok(parsed.tokens.some((token) => token.type === "parenthetical"));
    assert.ok(parsed.tokens.some((token) => token.type === "lyrics"));
  }
  for (const cue of ["123", "**123**", "bob", "BOB^^", "BLACK."]) {
    assert.equal(parseFountain(cue + "\nHello.").tokens[0].type, "action", cue);
  }
  assert.ok(!parseFountain("/* hidden */\n  \nBOB\nHello.").tokens.some((token) => token.type === "character"));
});

test("linear rule corrections keep ordinary title keys, sections, synopses, scene numbers and forced action", () => {
  // Expected values come from the unpatched fountain-js 1.2.4 tokenizer.
  const parsed = parseFountain("Title: A\n :x\nAuthor: B\n\n## Act   One\n\n=  Summary\n\nINT. HOUSE - DAY\t#1A#\n\n!BOB\nHi.\n\n  !x\n\n! y");
  assert.deepEqual(parsed.titlePage, [{ key: "title", value: "A" }, { key: "author", value: "B" }]);
  assert.deepEqual(parsed.tokens.map((token) => [token.type, token.text, token.scene_number, token.depth]), [
    ["section", "Act   One", undefined, 2],
    ["synopsis", "Summary", undefined, undefined],
    ["scene_heading", "INT. HOUSE - DAY", "1A", undefined],
    ["action", "BOB\nHi.", undefined, undefined],
    ["action", "  x", undefined, undefined],
    ["action", "! y", undefined, undefined],
  ]);
  assert.deepEqual(parsed.scenes[0].source, { line: 9, column: 1 });
});

test("empty Fountain content parses to an empty document instead of hanging", () => {
  // Run in a child so a regression fails the test instead of the whole suite.
  const result = spawnSync(
    process.execPath,
    ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(fountainModulePath)}).parseFountain("")))`],
    { timeout: CHILD_PROCESS_LIMIT_MS, encoding: "utf8" },
  );
  assert.equal(result.error, undefined, "parseFountain(\"\") did not return");
  assert.deepEqual(JSON.parse(result.stdout), { titlePage: [], tokens: [], scenes: [] });
});

test("blank-only Fountain content parses to an empty document", () => {
  for (const content of [" ", "\n", "\n\n", "   \n"]) {
    assert.deepEqual(parseFountain(content), { titlePage: [], tokens: [], scenes: [] });
  }
});

test("a dual-dialogue caret on the first cue does not leak into the next parse", () => {
  parseFountain("INT. A - DAY\n\nBOB^\nHi.\n\nAction.");
  const next = parseFountain("INT. B - DAY\n\nALICE\nHello.\n\nMore action.");
  assert.deepEqual(
    next.tokens.map((token) => token.type),
    ["scene_heading", "dialogue_begin", "character", "dialogue", "dialogue_end", "action"],
  );
  assert.equal(next.tokens[1].dual, undefined);
});

test("blocks with a two-space line keep their text, whatever was parsed before", () => {
  const source = "INT. HOUSE - DAY\n\nBOB\nWhere were you?\n  \n\n  \nThe door creaks open.\n\nMARY\nOut.";
  const first = parseFountain(source);
  assert.deepEqual(first.tokens.filter((token) => token.text).map((token) => [token.type, token.text]), [
    ["scene_heading", "INT. HOUSE - DAY"],
    ["character", "BOB"],
    ["dialogue", "Where were you?\n"],
    ["action", "  \nThe door creaks open."],
    ["character", "MARY"],
    ["dialogue", "Out."],
  ]);
  assert.equal(parseFountain("INT. HOUSE - DAY\n\n  \n\nBOB\nHi.").tokens[1].type, "spaces");
  // fountain-js 1.2.4 kept blank-block matching state between parses.
  parseFountain("The door creaks open.\n  \n");
  assert.deepEqual(parseFountain(source), first);
});

test("the lexer state reset targets the field fountain-js still uses", () => {
  parseFountain("BOB^\nHi.");
  assert.equal(Lexer.lastLineWasDualDialogue, true, "fountain-js renamed or removed the static flag; update parseFountain");
  parseFountain("BOB\nHi.");
  assert.equal(Lexer.lastLineWasDualDialogue, false);
});

test("lyrics as the first line of a dialogue block do not throw (patched fountain-js)", () => {
  const parsed = parseFountain("BOB\n~la la\nSpoken.");
  assert.deepEqual(
    parsed.tokens.map((token) => [token.type, token.text]),
    [
      ["dialogue_begin", undefined],
      ["character", "BOB"],
      ["lyrics", "la la"],
      ["dialogue", "Spoken."],
      ["dialogue_end", undefined],
    ],
  );
});

test("a parser exception becomes a parse-failed document instead of propagating", () => {
  const fountain = require(fountainModulePath);
  const originalParse = fountain.parseFountain;
  fountain.parseFountain = () => {
    throw new TypeError("boom\nPlease submit an issue to https://example.invalid");
  };
  delete require.cache[processingModulePath];
  try {
    const { prepareReaderDocument, FOUNTAIN_PARSE_FAILED_MESSAGE } = require(processingModulePath);
    assert.deepEqual(prepareReaderDocument("BOB\nHi.", "fountain"), {
      status: "parse-failed",
      message: `${FOUNTAIN_PARSE_FAILED_MESSAGE} (boom)`,
    });
  } finally {
    fountain.parseFountain = originalParse;
    delete require.cache[processingModulePath];
  }
});
