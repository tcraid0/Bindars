const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { Lexer } = require("fountain-js");

const fountainModulePath = require.resolve("../.tmp/workspace-tests/src/lib/fountain.js");
const processingModulePath = require.resolve("../.tmp/workspace-tests/src/lib/document-processing.js");
const { parseFountain } = require(fountainModulePath);

test("empty Fountain content parses to an empty document instead of hanging", () => {
  // Run in a child so a regression fails the test instead of the whole suite.
  const result = spawnSync(
    process.execPath,
    ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(fountainModulePath)}).parseFountain("")))`],
    { timeout: 5_000, encoding: "utf8" },
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
