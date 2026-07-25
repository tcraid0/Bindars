const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decodeUriComponentSafe,
  resolveImagePath,
  resolveMarkdownLink,
  toPathIdentityKey,
} = require("../.tmp/workspace-tests/src/lib/paths.js");
const {
  buildWorkspaceDoc,
} = require("../.tmp/workspace-tests/src/lib/workspace-index.js");

function makeMeta(name = "current.md") {
  return {
    path: `/workspace/notes/${name}`,
    relPath: `notes/${name}`,
    name,
    mtimeMs: 0,
    size: 0,
  };
}

function linksFor(markdown) {
  return buildWorkspaceDoc(makeMeta(), markdown).links;
}

function headingsFor(markdown) {
  return buildWorkspaceDoc(makeMeta(), markdown).headings;
}

function key(path) {
  return toPathIdentityKey(path);
}

test("resolveMarkdownLink accepts fountain targets and anchors", () => {
  assert.deepEqual(resolveMarkdownLink("../scripts/pilot.fountain#int-office", "/workspace/notes/current.md"), {
    path: "/workspace/scripts/pilot.fountain",
    anchor: "int-office",
  });
});

test("resolveMarkdownLink decodes percent-encoded paths and anchors", () => {
  assert.deepEqual(resolveMarkdownLink("./caf%C3%A9.md#caf%C3%A9", "/workspace/notes/current.md"), {
    path: "/workspace/notes/café.md",
    anchor: "café",
  });
});

test("resolveMarkdownLink preserves malformed percent-encoded anchors", () => {
  assert.deepEqual(resolveMarkdownLink("./target.md#bad%ZZanchor", "/workspace/notes/current.md"), {
    path: "/workspace/notes/target.md",
    anchor: "bad%ZZanchor",
  });
});

test("resolveMarkdownLink preserves malformed percent-encoded paths", () => {
  assert.deepEqual(resolveMarkdownLink("./bad%ZZ.md#ok", "/workspace/notes/current.md"), {
    path: "/workspace/notes/bad%ZZ.md",
    anchor: "ok",
  });
});

test("resolveMarkdownLink normalizes percent-encoded separators", () => {
  assert.deepEqual(resolveMarkdownLink("./a%2Fb.md", "/workspace/notes/current.md"), {
    path: "/workspace/notes/a/b.md",
    anchor: null,
  });
});

test("resolveMarkdownLink normalizes percent-encoded backslashes", () => {
  assert.deepEqual(resolveMarkdownLink("./a%5Cb.md", "/workspace/notes/current.md"), {
    path: "/workspace/notes/a/b.md",
    anchor: null,
  });
});

test("resolveMarkdownLink normalizes percent-encoded parent segments", () => {
  assert.deepEqual(resolveMarkdownLink("./%2E%2E/scripts/pilot.fountain", "/workspace/notes/current.md"), {
    path: "/workspace/scripts/pilot.fountain",
    anchor: null,
  });
});

test("resolveMarkdownLink preserves Windows drive-letter paths", () => {
  const resolved = resolveMarkdownLink("./other.md#Heading", "C:\\Users\\user\\docs\\current.md");

  assert.deepEqual(resolved, {
    path: "C:/Users/user/docs/other.md",
    anchor: "Heading",
  });
  assert.equal(toPathIdentityKey(resolved.path), toPathIdentityKey("C:\\Users\\user\\docs\\other.md"));
});

test("resolveImagePath preserves Windows drive-letter paths", () => {
  const resolved = resolveImagePath("./assets/image.png", "C:\\Users\\user\\docs\\current.md");

  assert.equal(resolved, "C:/Users/user/docs/assets/image.png");
  assert.equal(toPathIdentityKey(resolved), toPathIdentityKey("C:\\Users\\user\\docs\\assets\\image.png"));
});

test("resolveImagePath decodes spaces and non-ASCII filenames exactly once", () => {
  assert.equal(
    resolveImagePath("./images/caf%C3%A9%20cover.png", "/workspace/notes/current.md"),
    "/workspace/notes/images/café cover.png",
  );
  assert.equal(
    resolveImagePath("./images/literal%2520name.png", "/workspace/notes/current.md"),
    "/workspace/notes/images/literal%20name.png",
  );
});

test("resolveImagePath splits real delimiters before decoding filename delimiters", () => {
  assert.equal(
    resolveImagePath("./images/what%3Fnow%23final.png?cache=1#preview", "/workspace/notes/current.md"),
    "/workspace/notes/images/what?now#final.png",
  );
});

test("resolveImagePath preserves malformed percent escapes", () => {
  assert.equal(
    resolveImagePath("./images/bad%ZZname.png", "/workspace/notes/current.md"),
    "/workspace/notes/images/bad%ZZname.png",
  );
  assert.equal(decodeUriComponentSafe("bad%ZZfragment"), "bad%ZZfragment");
});

test("resolveImagePath rejects encoded and literal NUL bytes", () => {
  assert.equal(resolveImagePath("./images/bad%00name.png", "/workspace/notes/current.md"), "");
  assert.equal(resolveImagePath("./images/bad\0name.png", "/workspace/notes/current.md"), "");
});

test("resolveImagePath revalidates encoded schemes, rooted paths, and traversal", () => {
  for (const src of [
    "https%3A%2F%2Fexample.com%2Fimage.png",
    "%2Fetc%2Fimage.png",
    "%5Cimage.png",
    "%5C%5Cserver%5Cshare%5Cimage.png",
    "%43%3A%5CUsers%5Ctom%5Cimage.png",
    "%2E%2E%2Foutside.png",
    "images%2F%2E%2E%2F%2E%2E%2Foutside.png",
  ]) {
    assert.equal(
      resolveImagePath(src, "/workspace/notes/current.md"),
      "",
      `expected encoded unsafe image path to be blocked: ${src}`,
    );
  }
});

test("resolveMarkdownLink normalizes mixed Windows separators and traversal", () => {
  assert.deepEqual(resolveMarkdownLink("..\\scripts\\pilot.fountain", "C:/Users\\user/docs/current.md"), {
    path: "C:/Users/user/scripts/pilot.fountain",
    anchor: null,
  });
});

test("resolveMarkdownLink preserves UNC paths", () => {
  const resolved = resolveMarkdownLink("../other.md", "\\\\server\\share\\docs\\current.md");

  assert.deepEqual(resolved, {
    path: "//server/share/other.md",
    anchor: null,
  });
  assert.equal(toPathIdentityKey(resolved.path), toPathIdentityKey("\\\\server\\share\\other.md"));
});

test("resolveMarkdownLink blocks rooted backslash and UNC targets", () => {
  assert.equal(resolveMarkdownLink("\\target.md", "C:\\Users\\user\\docs\\current.md"), null);
  assert.equal(
    resolveMarkdownLink("\\\\server\\share\\target.md", "C:\\Users\\user\\docs\\current.md"),
    null,
  );
});

test("resolveImagePath blocks rooted backslash and UNC targets", () => {
  assert.equal(resolveImagePath("\\image.png", "C:\\Users\\user\\docs\\current.md"), "");
  assert.equal(
    resolveImagePath("\\\\server\\share\\image.png", "C:\\Users\\user\\docs\\current.md"),
    "",
  );
});

test("resolveMarkdownLink clamps parent traversal at the UNC share root", () => {
  const resolved = resolveMarkdownLink("../../outside.md", "\\\\server\\share\\docs\\current.md");

  assert.deepEqual(resolved, {
    path: "//server/share/outside.md",
    anchor: null,
  });
  assert.equal(
    toPathIdentityKey("\\\\server\\share\\docs\\..\\..\\outside.md"),
    toPathIdentityKey("//server/share/outside.md"),
  );
});

test("workspace link extraction indexes normal links and skips images", () => {
  const links = linksFor([
    "[Target](./target.md)",
    "![Target](./image.md)",
  ].join("\n"));

  assert.deepEqual(links, [key("/workspace/notes/target.md")]);
});

test("workspace link extraction preserves anchors and query strings for path resolution", () => {
  const links = linksFor("[Target](./target.md?draft=1#heading)");

  assert.deepEqual(links, [key("/workspace/notes/target.md")]);
});

test("workspace link extraction handles angle-bracket destinations with spaces", () => {
  const links = linksFor("[Target](<./space file.md>)");

  assert.deepEqual(links, [key("/workspace/notes/space file.md")]);
});

test("workspace link extraction handles nested and escaped parentheses", () => {
  const links = linksFor([
    "[Nested](./target-(final).md)",
    "[Escaped](./literal-\\).md)",
  ].join("\n"));

  assert.deepEqual(links.sort(), [
    key("/workspace/notes/literal-).md"),
    key("/workspace/notes/target-(final).md"),
  ].sort());
});

test("workspace link extraction handles reference-style links", () => {
  const links = linksFor([
    "[Full reference][target]",
    "[Collapsed reference][]",
    "[Shortcut reference]",
    "",
    "[target]: ./full.md",
    "[Collapsed reference]: ./collapsed.md",
    "[Shortcut reference]: ./shortcut.md",
  ].join("\n"));

  assert.deepEqual(links.sort(), [
    key("/workspace/notes/collapsed.md"),
    key("/workspace/notes/full.md"),
    key("/workspace/notes/shortcut.md"),
  ].sort());
});

test("workspace link extraction includes fountain links", () => {
  const links = linksFor("[Pilot](../scripts/pilot.fountain#int-office)");

  assert.deepEqual(links, [key("/workspace/scripts/pilot.fountain")]);
});

test("workspace link extraction ignores fenced code, external URLs, and absolute paths", () => {
  const links = linksFor([
    "```",
    "[Code](./code.md)",
    "```",
    "[External](https://example.com/target.md)",
    "[Absolute](/workspace/target.md)",
    "[Text](./target.txt)",
  ].join("\n"));

  assert.deepEqual(links, []);
});

test("workspace heading extraction does not close a longer fence with a shorter fence", () => {
  const headings = headingsFor([
    "````markdown",
    "```example",
    "## Phantom",
    "```",
    "## Still code",
    "````",
    "",
    "## Real Heading",
  ].join("\n"));

  assert.deepEqual(headings.map((heading) => heading.text), ["Real Heading"]);
});
