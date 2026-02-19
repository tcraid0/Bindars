const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeWorkspaceInsights,
} = require("../.tmp/workspace-tests/src/hooks/useWorkspaceInsights.js");

function makeDoc({
  path,
  relPath,
  name,
  title,
  bodyText,
  links = [],
  scenes = [],
}) {
  return {
    path,
    relPath,
    name,
    title,
    headings: [],
    bodyText,
    links,
    scenes,
  };
}

test("matches backlinks across Windows path variants", () => {
  const docs = [
    makeDoc({
      path: "C:\\\\Work\\\\Project Note.md",
      relPath: "Project Note.md",
      name: "Project Note.md",
      title: "Project Note",
      bodyText: "current doc",
      scenes: [{ id: "scene-1", label: "INT. OFFICE - DAY", line: 1, headingId: "int-office-day" }],
    }),
    makeDoc({
      path: "C:\\\\Work\\\\Backlinks.md",
      relPath: "Backlinks.md",
      name: "Backlinks.md",
      title: "Backlinks",
      bodyText: "linked doc",
      links: ["/c:/work/project note.md"],
    }),
    makeDoc({
      path: "C:\\\\Work\\\\Mentions.md",
      relPath: "Mentions.md",
      name: "Mentions.md",
      title: "Mentions",
      bodyText: "The Project Note should be linked from here.",
      links: [],
    }),
  ];

  const insights = computeWorkspaceInsights(docs, "\\\\?\\C:\\Work\\Project Note.md");

  assert.equal(insights.backlinks.length, 1);
  assert.equal(insights.backlinks[0].fromPath, "C:\\\\Work\\\\Backlinks.md");
  assert.equal(insights.mentions.length, 1);
  assert.equal(insights.mentions[0].path, "C:\\\\Work\\\\Mentions.md");
  assert.equal(insights.scenes.length, 1);
});

test("does not report unlinked mention when file already links to current doc", () => {
  const docs = [
    makeDoc({
      path: "/workspace/current.md",
      relPath: "current.md",
      name: "current.md",
      title: "Current",
      bodyText: "current",
    }),
    makeDoc({
      path: "/workspace/other.md",
      relPath: "other.md",
      name: "other.md",
      title: "Other",
      bodyText: "Current appears by name but this doc also links to it.",
      links: ["/workspace/current.md"],
    }),
  ];

  const insights = computeWorkspaceInsights(docs, "/workspace/current.md");

  assert.equal(insights.backlinks.length, 1);
  assert.equal(insights.mentions.length, 0);
});

test("does not report unlinked mention for substring match inside word", () => {
  const docs = [
    makeDoc({
      path: "/workspace/notes.md",
      relPath: "notes.md",
      name: "notes.md",
      title: "Notes",
      bodyText: "current",
    }),
    makeDoc({
      path: "/workspace/other.md",
      relPath: "other.md",
      name: "other.md",
      title: "Other",
      bodyText: "xNotesy and preNotespost are embedded substrings, not mentions.",
      links: [],
    }),
  ];

  const insights = computeWorkspaceInsights(docs, "/workspace/notes.md");
  assert.equal(insights.mentions.length, 0);
});
