const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeScriptStats,
  isMarkdownSceneHeadingText,
  isSceneHeadingText,
  parseFountain,
  parseSceneHeading,
} = require("../.tmp/workspace-tests/src/lib/fountain.js");

test("parseSceneHeading extracts interior scene metadata", () => {
  assert.deepEqual(parseSceneHeading("INT. COFFEE SHOP - NIGHT"), {
    intExt: "INT",
    location: "COFFEE SHOP",
    timeOfDay: "NIGHT",
  });
});

test("parseSceneHeading extracts exterior scene metadata", () => {
  assert.deepEqual(parseSceneHeading("EXT. PARK - DAY"), {
    intExt: "EXT",
    location: "PARK",
    timeOfDay: "DAY",
  });
});

test("parseSceneHeading supports int slash ext headings", () => {
  assert.deepEqual(parseSceneHeading("INT/EXT. CAR - CONTINUOUS"), {
    intExt: "INT/EXT",
    location: "CAR",
    timeOfDay: "CONTINUOUS",
  });
});

test("parseSceneHeading supports forced interior scene headings", () => {
  assert.deepEqual(parseSceneHeading(".INT. HOUSE - DAY"), {
    intExt: "INT",
    location: "HOUSE",
    timeOfDay: "DAY",
  });
});

test("parseSceneHeading supports bare I/E headings", () => {
  assert.deepEqual(parseSceneHeading("I/E CAR - DAY"), {
    intExt: "INT/EXT",
    location: "CAR",
    timeOfDay: "DAY",
  });
});

test("parseSceneHeading splits location from the last dash only", () => {
  assert.deepEqual(parseSceneHeading("INT. NORTH-SIDE DINER - NIGHT"), {
    intExt: "INT",
    location: "NORTH-SIDE DINER",
    timeOfDay: "NIGHT",
  });
});

test("parseSceneHeading keeps time of day optional", () => {
  assert.deepEqual(parseSceneHeading("INT. OFFICE"), {
    intExt: "INT",
    location: "OFFICE",
    timeOfDay: null,
  });
});

test("parseSceneHeading treats forced headings as non INT EXT locations", () => {
  assert.deepEqual(parseSceneHeading(".FLASHBACK"), {
    intExt: null,
    location: "FLASHBACK",
    timeOfDay: null,
  });
});

test("parseSceneHeading treats EST headings as non INT EXT locations", () => {
  assert.deepEqual(parseSceneHeading("EST. THE WHITE HOUSE"), {
    intExt: null,
    location: "THE WHITE HOUSE",
    timeOfDay: null,
  });
});

test("parseSceneHeading splits EST headings on the last dash", () => {
  assert.deepEqual(parseSceneHeading("EST. THE WHITE HOUSE - DAWN"), {
    intExt: null,
    location: "THE WHITE HOUSE",
    timeOfDay: "DAWN",
  });
});

test("parseSceneHeading splits forced headings on the last dash", () => {
  assert.deepEqual(parseSceneHeading(".FLASHBACK - LATE NIGHT"), {
    intExt: null,
    location: "FLASHBACK",
    timeOfDay: "LATE NIGHT",
  });
});

test("isSceneHeadingText matches Fountain scene heading forms", () => {
  assert.equal(isSceneHeadingText("INT./EXT. CAR - DAY"), true);
  assert.equal(isSceneHeadingText("INT WAREHOUSE - DAY"), true);
  assert.equal(isSceneHeadingText("EXT FIELD"), true);
  assert.equal(isSceneHeadingText("EST THE WHITE HOUSE - DAWN"), true);
  assert.equal(isSceneHeadingText(".FLASHBACK - NIGHT"), true);
  assert.equal(isSceneHeadingText("INTERIOR NOTES"), false);
  assert.equal(isSceneHeadingText(""), false);
});

test("isMarkdownSceneHeadingText excludes forced-dot Fountain headings", () => {
  assert.equal(isMarkdownSceneHeadingText("INT. HOUSE - DAY"), true);
  assert.equal(isMarkdownSceneHeadingText("EST THE WHITE HOUSE - DAWN"), true);
  assert.equal(isMarkdownSceneHeadingText(".FLASHBACK - NIGHT"), false);
  assert.equal(isMarkdownSceneHeadingText(".NET Migration"), false);
  assert.equal(isMarkdownSceneHeadingText(".env setup"), false);
});

test("computeScriptStats derives scene and character stats from parsed fountain", () => {
  const content = [
    "A *cold* open.",
    "",
    "INT. COFFEE SHOP - NIGHT",
    "",
    "SARAH",
    "(whispering)",
    "Hello there.",
    "",
    "MIKE",
    "Hi Sarah.",
    "",
    "EXT. PARK - DAY",
    "",
    "SARAH (V.O.)",
    "Still here.",
    "",
    "Wind moves through trees.",
  ].join("\n");

  const stats = computeScriptStats(parseFountain(content));
  const sarah = stats.characters.find((character) => character.name === "SARAH");
  const mike = stats.characters.find((character) => character.name === "MIKE");

  assert.equal(stats.scenes.length, 2);
  assert.equal(stats.totalPages, 1);
  assert.equal(stats.estimatedRuntimeMinutes, 1);
  assert.equal(stats.dialoguePercentage, 50);
  assert.equal(stats.uniqueLocationCount, 2);
  assert.equal(stats.speakingCharacterCount, 2);
  assert.deepEqual(
    stats.scenes.map((scene) => scene.sceneId),
    ["int-coffee-shop-night", "ext-park-day"],
  );
  assert.deepEqual(stats.scenes[0].characterNames, ["MIKE", "SARAH"]);
  assert.equal(stats.scenes[0].wordCount, 7);
  assert.equal(stats.scenes[1].wordCount, 8);
  assert.equal(sarah?.dialogueCount, 2);
  assert.equal(sarah?.dialogueWordCount, 5);
  assert.equal(sarah?.sceneCount, 2);
  assert.equal(sarah?.firstSceneId, "int-coffee-shop-night");
  assert.equal(sarah?.lastSceneId, "ext-park-day");
  assert.equal(mike?.dialogueCount, 1);
  assert.equal(mike?.dialogueWordCount, 2);
  assert.equal(mike?.sceneCount, 1);
});

test("computeScriptStats folds pre-scene content into totals without creating a scene row", () => {
  const content = [
    "Cold open action.",
    "",
    "INT. OFFICE - DAY",
    "",
    "SARAH",
    "Hello.",
  ].join("\n");

  const stats = computeScriptStats(parseFountain(content));

  assert.equal(stats.scenes.length, 1);
  assert.equal(stats.scenes[0].sceneId, "int-office-day");
  assert.equal(stats.scenes[0].wordCount, 2);
  assert.equal(stats.totalPages, 1);
});

test("computeScriptStats keeps EST and forced heading locations separate from time of day", () => {
  const content = [
    "EST. THE WHITE HOUSE - DAWN",
    "",
    "Action one.",
    "",
    ".FLASHBACK - NIGHT",
    "",
    "Action two.",
  ].join("\n");

  const stats = computeScriptStats(parseFountain(content));

  assert.equal(stats.uniqueLocationCount, 2);
  assert.deepEqual(
    stats.scenes.map((scene) => scene.parsed),
    [
      { intExt: null, location: "THE WHITE HOUSE", timeOfDay: "DAWN" },
      { intExt: null, location: "FLASHBACK", timeOfDay: "NIGHT" },
    ],
  );
});

test("computeScriptStats merges V.O. and normal character entries", () => {
  const content = [
    "INT. OFFICE - DAY",
    "",
    "SARAH",
    "Hello there.",
    "",
    "EXT. STREET - NIGHT",
    "",
    "SARAH (V.O.)",
    "Still talking.",
  ].join("\n");

  const stats = computeScriptStats(parseFountain(content));

  assert.equal(stats.characters.length, 1);
  assert.equal(stats.characters[0].name, "SARAH");
  assert.equal(stats.characters[0].dialogueCount, 2);
  assert.equal(stats.characters[0].dialogueWordCount, 4);
});

test("computeScriptStats supports bare I/E scene headings", () => {
  const content = [
    "I/E CAR - DAY",
    "",
    "SARAH",
    "Still driving.",
  ].join("\n");

  const stats = computeScriptStats(parseFountain(content));

  assert.equal(stats.scenes.length, 1);
  assert.deepEqual(stats.scenes[0].parsed, {
    intExt: "INT/EXT",
    location: "CAR",
    timeOfDay: "DAY",
  });
});

test("computeScriptStats excludes sections synopses and notes from page estimates", () => {
  const outlineWords = Array(80).fill("outline").join(" ");
  const synopsisWords = Array(80).fill("summary").join(" ");
  const noteWords = Array(80).fill("note").join(" ");
  const content = [
    `# ${outlineWords}`,
    "",
    `= ${synopsisWords}`,
    "",
    "INT. HOUSE - DAY",
    "",
    `[[${noteWords}]]`,
    "",
    "Action line.",
    "",
    "SARAH",
    "Hello there.",
  ].join("\n");

  const stats = computeScriptStats(parseFountain(content));

  assert.equal(stats.totalPages, 1);
  assert.equal(stats.estimatedRuntimeMinutes, 1);
  assert.equal(stats.dialoguePercentage, 50);
  assert.equal(stats.scenes.length, 1);
  assert.equal(stats.scenes[0].wordCount, 5);
  assert.equal(stats.scenes[0].pageEstimate, 0);
});

test("computeScriptStats counts both sides of dual dialogue", () => {
  const content = [
    "INT. OFFICE - DAY",
    "",
    "ALICE",
    "Hello.",
    "",
    "BOB^",
    "Hi.",
  ].join("\n");

  const stats = computeScriptStats(parseFountain(content));

  assert.equal(stats.characters.length, 2);
  assert.equal(stats.characters[0].dialogueWordCount, 1);
  assert.equal(stats.characters[1].dialogueWordCount, 1);
  assert.equal(stats.dialoguePercentage, 100);
});

test("computeScriptStats returns zero-safe stats for empty input", () => {
  const stats = computeScriptStats({
    titlePage: [],
    tokens: [],
    scenes: [],
  });

  assert.deepEqual(stats, {
    totalPages: 0,
    estimatedRuntimeMinutes: 0,
    speakingCharacterCount: 0,
    uniqueLocationCount: 0,
    dialoguePercentage: 0,
    scenes: [],
    characters: [],
  });
});
