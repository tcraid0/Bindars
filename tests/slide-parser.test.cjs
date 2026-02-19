const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseSlides } = require("../.tmp/workspace-tests/src/lib/slide-parser");

describe("parseSlides", () => {
  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(parseSlides(""), []);
    assert.deepStrictEqual(parseSlides("  \n  "), []);
  });

  it("splits on --- horizontal rules", () => {
    const input = "# Slide 1\n\nHello\n\n---\n\n# Slide 2\n\nWorld\n\n---\n\n# Slide 3";
    const slides = parseSlides(input);
    assert.equal(slides.length, 3);
    assert.ok(slides[0].content.includes("Slide 1"));
    assert.ok(slides[1].content.includes("Slide 2"));
    assert.ok(slides[2].content.includes("Slide 3"));
  });

  it("preserves code blocks containing ---", () => {
    const input = "# Slide 1\n\n```yaml\nkey: value\n---\nmore: stuff\n```\n\n---\n\n# Slide 2";
    const slides = parseSlides(input);
    assert.equal(slides.length, 2);
    assert.ok(slides[0].content.includes("key: value"));
    assert.ok(slides[0].content.includes("---"));
    assert.ok(slides[0].content.includes("more: stuff"));
    assert.ok(slides[1].content.includes("Slide 2"));
  });

  it("falls back to ## headings when no ---", () => {
    const input = "# Title\n\nIntro\n\n## Section A\n\nContent A\n\n## Section B\n\nContent B";
    const slides = parseSlides(input);
    assert.equal(slides.length, 3);
    assert.ok(slides[0].content.includes("# Title"));
    assert.ok(slides[1].content.includes("## Section A"));
    assert.ok(slides[2].content.includes("## Section B"));
  });

  it("handles frontmatter title slide", () => {
    const input = "---\ntitle: My Presentation\nauthor: Jane Doe\ndate: 2026-01-15\n---\n\n# First slide\n\nContent\n\n---\n\n# Second slide";
    const slides = parseSlides(input);
    assert.ok(slides.length >= 3);
    assert.ok(slides[0].content.includes("# My Presentation"));
    assert.ok(slides[0].content.includes("Jane Doe"));
    assert.ok(slides[0].content.includes("2026-01-15"));
  });

  it("single slide with no separators or headings", () => {
    const input = "Just some plain text content.";
    const slides = parseSlides(input);
    assert.equal(slides.length, 1);
    assert.ok(slides[0].content.includes("Just some plain text"));
  });

  it("filters out empty slides from consecutive ---", () => {
    const input = "# Slide 1\n\n---\n\n---\n\n# Slide 2";
    const slides = parseSlides(input);
    assert.equal(slides.length, 2);
  });

  it("indexes slides sequentially starting from 0", () => {
    const input = "A\n\n---\n\nB\n\n---\n\nC";
    const slides = parseSlides(input);
    for (let i = 0; i < slides.length; i++) {
      assert.equal(slides[i].index, i);
    }
  });

  it("preserves tilde code blocks containing ---", () => {
    const input = "# Slide 1\n\n~~~yaml\nkey: value\n---\nmore: stuff\n~~~\n\n---\n\n# Slide 2";
    const slides = parseSlides(input);
    assert.equal(slides.length, 2);
    assert.ok(slides[0].content.includes("key: value"));
    assert.ok(slides[0].content.includes("---"));
    assert.ok(slides[0].content.includes("more: stuff"));
    assert.ok(slides[1].content.includes("Slide 2"));
  });

  it("does not close a backtick fence with tildes", () => {
    const input = "# Slide 1\n\n```\n~~~\n---\n```\n\n---\n\n# Slide 2";
    const slides = parseSlides(input);
    assert.equal(slides.length, 2);
    assert.ok(slides[0].content.includes("---"));
    assert.ok(slides[1].content.includes("Slide 2"));
  });

  it("preserves indented code fences containing ---", () => {
    const input = "# Slide 1\n\n   ```yaml\nkey: value\n---\nmore: stuff\n   ```\n\n---\n\n# Slide 2";
    const slides = parseSlides(input);
    assert.equal(slides.length, 2);
    assert.ok(slides[0].content.includes("key: value"));
    assert.ok(slides[0].content.includes("---"));
    assert.ok(slides[1].content.includes("Slide 2"));
  });

  it("does not treat setext heading underlines as slide breaks", () => {
    const input = "Intro\n\n---\n\nSetext Title\n---\n\nMore content";
    const slides = parseSlides(input);
    assert.equal(slides.length, 2);
    assert.ok(slides[1].content.includes("Setext Title"));
    assert.ok(slides[1].content.includes("---"));
    assert.ok(slides[1].content.includes("More content"));
  });
});
