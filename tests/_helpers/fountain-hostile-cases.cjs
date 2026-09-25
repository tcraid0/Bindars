// Screenplays that once stalled the Fountain pipeline, shared by the robustness
// tests (Node) and scripts/verify-jsc.mjs (JavaScriptCore).
const hostileCases = {
  centered: "INT. A - DAY\n\n>" + "a<>".repeat(60) + "a<x",
  dialogue: "INT. A - DAY\n\n" + " ".repeat(1_000) + "bob\nhi",
  transitionSpaces: "INT. A - DAY\n\n" + " ".repeat(1_000_000) + "bob\nhi",
  transitionTabs: "INT. A - DAY\n\n" + "\t".repeat(1_000_000) + "bob\nhi",
  transitionSuffix: "INT. A - DAY\n\n" + " ".repeat(1_000_000) + "bob TO:nope",
  transitionBody: "INT. A - DAY\n\n" + " ".repeat(1_000_000) + "bob TO:\nhi",
  transitionForcedBody: "INT. A - DAY\n\n>" + " ".repeat(1_000_000) + "bob\nhi",
  blankLines: "INT. A - DAY\n\na\n" + " ".repeat(200_000) + "x",
  titleTrim: "Title: A" + " ".repeat(128_000) + "b\nAuthor: me\n\nINT. A - DAY",
  centeredTrim: ">a" + " ".repeat(128_000) + "b<",
  unclosedComments: ("/*" + "a".repeat(400) + " ").repeat(8_000),
  unmatchedEmphasis: "!" + ("_" + "a".repeat(100) + " ").repeat(8_000),
  titleLineSeparator: "Title: " + "a".repeat(40) + "\u2028",
  authorParagraphSeparator: "Author: " + "a".repeat(48) + "\u2029\n\nINT. HOUSE - DAY\n\nBOB\nHi.",
  titleKeySpaces: "Title: x\n" + " ".repeat(1_000_000) + " TO:",
  readingStatsTitle: "Title: x\n" + " ".repeat(1_000_000) + "y",
  sectionSpaces: "INT. A - DAY\n\n# " + " ".repeat(1_000_000) + "x\ny",
  sectionHashes: "INT. A - DAY\n\n" + "#".repeat(1_000_000) + "\ny",
  synopsisSpaces: "INT. A - DAY\n\n= " + " ".repeat(1_000_000) + "x\ny",
  sceneNumberSpaces: "INT. A" + " ".repeat(1_000_000) + "B",
  characterExtensions: "INT. A - DAY\n\nBOB " + "(x)".repeat(333_333) + "*\nhi",
  commentLineSeparators: "INT. A - DAY\n\n/*" + "\u2028".repeat(1_000_000) + "x*/\n\nBOB\nHi.",
  actionLineSeparators: "INT. A - DAY\n\na" + "\u2028".repeat(1_000_000) + "b",
};

// Text each hostile document must still contain after parsing, so a fast
// but empty or truncated result fails.
const retainedText = {
  centered: "a<>a<>a",
  dialogue: "bob\nhi",
  transitionSpaces: "bob",
  transitionTabs: "bob",
  transitionSuffix: "bob",
  transitionBody: "bob",
  transitionForcedBody: "bob",
  blankLines: "  x",
  titleTrim: "b\nme",
  centeredTrim: "  b",
  unclosedComments: "a /*a",
  unmatchedEmphasis: "a _a",
  titleLineSeparator: "a".repeat(40),
  authorParagraphSeparator: "Hi.",
  titleKeySpaces: "TO:",
  readingStatsTitle: "x\ny",
  sectionSpaces: "  x\ny",
  sectionHashes: "##\ny",
  synopsisSpaces: "  x\ny",
  sceneNumberSpaces: "  B",
  characterExtensions: "*\nhi",
  commentLineSeparators: "Hi.",
  actionLineSeparators: "\u2028b",
};

module.exports = { hostileCases, retainedText };
