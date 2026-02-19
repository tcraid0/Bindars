const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFountain,
  fountainToSearchableText,
  normalizeCharacterName,
  extractCharacters,
} = require("../.tmp/workspace-tests/src/lib/fountain.js");
const {
  buildWorkspaceDoc,
} = require("../.tmp/workspace-tests/src/lib/workspace-index.js");

function makeMeta(name) {
  return {
    path: `/workspace/${name}`,
    relPath: name,
    name,
    mtimeMs: 0,
    size: 0,
  };
}

test("parseFountain extracts normalized title-page fields", () => {
  const content = [
    "Title: The Last Day",
    "Credit: Written by",
    "Author: Jane Doe",
    "Draft date: 2026-02-12",
    "Contact: jane@example.com",
    "",
    "INT. OFFICE - DAY",
    "",
    "SARAH",
    "Hello.",
  ].join("\n");

  const parsed = parseFountain(content);
  assert.deepEqual(parsed.titlePage, [
    { key: "title", value: "The Last Day" },
    { key: "credit", value: "Written by" },
    { key: "author", value: "Jane Doe" },
    { key: "draft date", value: "2026-02-12" },
    { key: "contact", value: "jane@example.com" },
  ]);

  const searchable = fountainToSearchableText(content);
  assert.match(searchable, /\bThe Last Day\b/);
  assert.match(searchable, /\bJane Doe\b/);
  assert.match(searchable, /\bHello\./);
});

test("scene IDs are deterministic, deduplicated, and non-empty", () => {
  const content = [
    "INT. OFFICE - DAY",
    "",
    "EXT. PARK - NIGHT",
    "",
    "INT. OFFICE - DAY",
    "",
    ".?",
    "",
    ".?",
  ].join("\n");

  const parsed = parseFountain(content);
  assert.deepEqual(
    parsed.scenes.map((scene) => scene.id),
    ["int-office-day", "ext-park-night", "int-office-day-1", "scene", "scene-1"],
  );
});

test("buildWorkspaceDoc indexes fountain title, headings, and scenes", () => {
  const content = [
    "Title: The Last Day",
    "Author: Jane Doe",
    "",
    "INT. OFFICE - DAY",
    "",
    "SARAH",
    "Hello.",
  ].join("\n");

  const doc = buildWorkspaceDoc(makeMeta("episode.fountain"), content);

  assert.equal(doc.title, "The Last Day");
  assert.deepEqual(doc.links, []);
  assert.equal(doc.headings.length, 1);
  assert.equal(doc.headings[0].id, "int-office-day");
  assert.equal(doc.scenes.length, 1);
  assert.equal(doc.scenes[0].id, "scene-int-office-day");
  assert.equal(doc.scenes[0].headingId, "int-office-day");
  assert.match(doc.bodyText, /\bHello\./);
});

test("buildWorkspaceDoc falls back to filename when fountain title is missing", () => {
  const content = [
    "INT. HALLWAY - DAY",
    "",
    "A quiet corridor.",
  ].join("\n");

  const doc = buildWorkspaceDoc(makeMeta("no-title.fountain"), content);
  assert.equal(doc.title, "no-title");
});

test("normalizeCharacterName strips V.O., O.S., CONT'D extensions", () => {
  assert.equal(normalizeCharacterName("SARAH (V.O.)"), "SARAH");
  assert.equal(normalizeCharacterName("JOHN (O.S.)"), "JOHN");
  assert.equal(normalizeCharacterName("SARAH (CONT'D)"), "SARAH");
  assert.equal(normalizeCharacterName("MIKE (O.C.)"), "MIKE");
  assert.equal(normalizeCharacterName("sarah"), "SARAH");
  assert.equal(normalizeCharacterName("  Bob  "), "BOB");
});

test("extractCharacters collects unique characters with correct counts", () => {
  const content = [
    "INT. OFFICE - DAY",
    "",
    "SARAH",
    "Hello.",
    "",
    "JOHN",
    "Hi there.",
    "",
    "SARAH",
    "How are you?",
    "",
    "EXT. PARK - NIGHT",
    "",
    "SARAH (V.O.)",
    "It was a long day.",
  ].join("\n");

  const parsed = parseFountain(content);
  const chars = extractCharacters(parsed);

  assert.equal(chars.length, 2);
  assert.equal(chars[0].name, "SARAH");
  assert.equal(chars[0].dialogueCount, 3);
  assert.equal(chars[1].name, "JOHN");
  assert.equal(chars[1].dialogueCount, 1);
});

test("extractCharacters sorts by dialogue count descending", () => {
  const content = [
    "INT. OFFICE - DAY",
    "",
    "JOHN",
    "Line one.",
    "",
    "JOHN",
    "Line two.",
    "",
    "SARAH",
    "One line.",
    "",
    "MIKE",
    "First.",
    "",
    "MIKE",
    "Second.",
    "",
    "MIKE",
    "Third.",
  ].join("\n");

  const parsed = parseFountain(content);
  const chars = extractCharacters(parsed);

  assert.equal(chars[0].name, "MIKE");
  assert.equal(chars[0].dialogueCount, 3);
  assert.equal(chars[1].name, "JOHN");
  assert.equal(chars[1].dialogueCount, 2);
  assert.equal(chars[2].name, "SARAH");
  assert.equal(chars[2].dialogueCount, 1);
});

test("extractCharacters tracks firstSceneId", () => {
  const content = [
    "INT. OFFICE - DAY",
    "",
    "SARAH",
    "Hello.",
    "",
    "EXT. PARK - NIGHT",
    "",
    "JOHN",
    "Hi.",
  ].join("\n");

  const parsed = parseFountain(content);
  const chars = extractCharacters(parsed);

  const sarah = chars.find((c) => c.name === "SARAH");
  const john = chars.find((c) => c.name === "JOHN");

  assert.equal(sarah.firstSceneId, "int-office-day");
  assert.equal(john.firstSceneId, "ext-park-night");
});
