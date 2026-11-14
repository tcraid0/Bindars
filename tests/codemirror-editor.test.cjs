const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { flushSync } = require("./_helpers/react.cjs");
const { createRoot } = require("react-dom/client");
const { undo, redo } = require("@codemirror/commands");
const { forceParsing, syntaxTree } = require("@codemirror/language");
const { EditorView } = require("@codemirror/view");
const {
  SearchQuery,
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  searchPanelOpen,
  setSearchQuery,
} = require("@codemirror/search");
const { installDom } = require("./_helpers/dom.cjs");
const { findEditorView, replaceEditorDocument } = require("./_helpers/codemirror.cjs");
const {
  markdownFormattingEnabled,
  markdownHeadingViewPlugin,
} = require("../.tmp/workspace-tests/src/components/markdown-decorations.js");

async function waitForPublication() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 240));
  });
}

function dispatchKey(target, key, options = {}) {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function setPanelQuery(host, search, replace = "") {
  const searchField = host.querySelector('input[name="search"]');
  const replaceField = host.querySelector('input[name="replace"]');
  assert.ok(searchField);
  assert.ok(replaceField);
  searchField.value = search;
  searchField.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
  replaceField.value = replace;
  replaceField.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
  return { searchField, replaceField };
}

function clickPanelButton(host, name) {
  const button = host.querySelector(`button[name="${name}"]`);
  assert.ok(button, `expected search panel button ${name}`);
  button.click();
}

async function renderEditor(props, { strict = false, key = "session" } = {}) {
  await installDom();
  const { CodeMirrorEditor } = require(
    "../.tmp/workspace-tests/src/components/CodeMirrorEditor.js"
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref = React.createRef();

  function element(nextProps = props, nextKey = key) {
    const editor = React.createElement(CodeMirrorEditor, {
      fileType: "markdown",
      markdownFormattingEnabled: true,
      ...nextProps,
      key: nextKey,
      ref,
    });
    return strict ? React.createElement(React.StrictMode, null, editor) : editor;
  }

  flushSync(() => root.render(element()));
  return {
    host,
    ref,
    rerender(nextProps, nextKey = key) {
      props = nextProps;
      key = nextKey;
      flushSync(() => root.render(element(nextProps, nextKey)));
    },
    cleanup() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}

test("CodeMirrorEditor mounts exact empty and non-empty documents and focuses its accessible surface", async () => {
  for (const initialDocument of ["", "# Draft\n\nWords\n"]) {
    const rendered = await renderEditor({
      initialDocument,
      onBufferChange() { return false; },
    });

    try {
      const view = findEditorView(rendered.host);
      assert.equal(view.state.doc.toString(), initialDocument);
      assert.ok(document.activeElement === view.contentDOM);
      assert.equal(view.contentDOM.getAttribute("role"), "textbox");
      assert.equal(view.contentDOM.getAttribute("aria-label"), "Edit document");
      assert.equal(view.contentDOM.getAttribute("aria-multiline"), "true");
      assert.equal(view.contentDOM.getAttribute("contenteditable"), "true");
    } finally {
      rendered.cleanup();
    }
  }
});

test("CodeMirrorEditor scopes Mac spelling to the document across search panel reopenings", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const { platform, spellcheck, searchSpellcheck, searchAutocorrect } of [
      { platform: "MacIntel", spellcheck: "true", searchSpellcheck: "false", searchAutocorrect: "off" },
      { platform: "Linux x86_64", spellcheck: "false", searchSpellcheck: null, searchAutocorrect: null },
    ]) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { platform, userAgent: "" },
      });
      const rendered = await renderEditor({
        initialDocument: "Spelling example",
        onBufferChange() { return false; },
      });
      try {
        const view = findEditorView(rendered.host);
        assert.equal(view.contentDOM.getAttribute("spellcheck"), spellcheck, platform);
        assert.equal(view.contentDOM.getAttribute("autocorrect"), "off", platform);

        let previousFields = [];
        for (let opening = 0; opening < 2; opening++) {
          assert.equal(openSearchPanel(view), true);
          const fields = ["search", "replace"].map((name) => (
            rendered.host.querySelector(`.cm-search input[name="${name}"]`)
          ));
          for (const [index, field] of fields.entries()) {
            assert.ok(field, "expected the generated Find and Replace inputs");
            assert.equal(field.getAttribute("spellcheck"), searchSpellcheck, platform);
            assert.equal(field.getAttribute("autocorrect"), searchAutocorrect, platform);
            if (opening > 0) {
              assert.ok(field !== previousFields[index], "reopening must create fresh inputs");
            }
          }
          assert.equal(view.contentDOM.getAttribute("spellcheck"), spellcheck, platform);
          previousFields = fields;
          assert.equal(closeSearchPanel(view), true);
          assert.ok(rendered.host.querySelector(".cm-search") === null);
        }
      } finally {
        rendered.cleanup();
      }
    }
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
});

test("CodeMirrorEditor leaves exactly one live view through the StrictMode setup cycle", async () => {
  const rendered = await renderEditor({
    initialDocument: "Strict draft",
    onBufferChange() { return false; },
  }, { strict: true });

  try {
    assert.equal(rendered.host.querySelectorAll(".cm-editor").length, 1);
    assert.equal(findEditorView(rendered.host).state.doc.toString(), "Strict draft");
  } finally {
    rendered.cleanup();
  }
  assert.equal(document.querySelectorAll(".cm-editor").length, 0);
});

test("document changes debounce and coalesce without publishing selection-only transactions", async () => {
  const publications = [];
  const rendered = await renderEditor({
    initialDocument: "Draft",
    onBufferChange(content) {
      publications.push(content);
      return true;
    },
  });

  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: 2 } });
    await waitForPublication();
    assert.deepEqual(publications, []);

    replaceEditorDocument(view, "First");
    replaceEditorDocument(view, "Second — 你好 👋\n");
    await waitForPublication();
    assert.deepEqual(publications, ["Second — 你好 👋\n"]);
  } finally {
    rendered.cleanup();
  }
});

test("synchronous flush publishes the newest complete text once and cancels its timer", async () => {
  const publications = [];
  const rendered = await renderEditor({
    initialDocument: "Draft",
    onBufferChange(content) {
      publications.push(content);
      return content !== "Draft";
    },
  });

  try {
    const view = findEditorView(rendered.host);
    replaceEditorDocument(view, "Newest\ncomplete\n");
    assert.equal(rendered.ref.current.flushPendingChanges(), true);
    assert.equal(rendered.ref.current.flushPendingChanges(), null);
    assert.deepEqual(publications, ["Newest\ncomplete\n"]);
    await waitForPublication();
    assert.deepEqual(publications, ["Newest\ncomplete\n"]);

    replaceEditorDocument(view, "");
    assert.equal(rendered.ref.current.flushPendingChanges(), true);
    assert.equal(publications.at(-1), "");
  } finally {
    rendered.cleanup();
  }
});

test("search opens in the native top panel and finds document matches", async () => {
  const rendered = await renderEditor({
    initialDocument: "alpha beta alpha",
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    const open = dispatchKey(view.contentDOM, "f", { ctrlKey: true });
    assert.equal(open.defaultPrevented, true);
    assert.equal(searchPanelOpen(view.state), true);
    assert.ok(rendered.host.querySelector(".cm-panels-top"));

    const { searchField } = setPanelQuery(rendered.host, "alpha");
    assert.equal(searchField.getAttribute("main-field"), "true");
    const query = getSearchQuery(view.state);
    const renderedMatchCount = rendered.host.querySelectorAll(".cm-searchMatch").length;
    closeSearchPanel(view);
    assert.equal(query.search, "alpha");
    assert.equal(renderedMatchCount, 2);
  } finally {
    rendered.cleanup();
  }
});

test("Mod-d belongs to CodeMirror and selects successive occurrences", async () => {
  const rendered = await renderEditor({
    initialDocument: "word gap word",
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: 1 } });
    const first = dispatchKey(view.contentDOM, "d", { ctrlKey: true });
    const second = dispatchKey(view.contentDOM, "d", { ctrlKey: true });
    assert.equal(first.defaultPrevented, true);
    assert.equal(second.defaultPrevented, true);
    assert.equal(view.state.selection.ranges.length, 2);
    assert.deepEqual(
      view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to)),
      ["word", "word"],
    );
  } finally {
    rendered.cleanup();
  }
});

test("replace-next and replace-all publish complete undoable changes", async () => {
  const publications = [];
  const rendered = await renderEditor({
    initialDocument: "one one one",
    onBufferChange(content) {
      publications.push(content);
      return true;
    },
  });

  try {
    const view = findEditorView(rendered.host);
    openSearchPanel(view);
    setPanelQuery(rendered.host, "one", "two");
    clickPanelButton(rendered.host, "next");
    clickPanelButton(rendered.host, "replace");
    assert.equal(view.state.sliceDoc(), "two one one");
    assert.equal(rendered.ref.current.flushPendingChanges(), true);
    assert.deepEqual(publications, ["two one one"]);
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "one one one");

    clickPanelButton(rendered.host, "replaceAll");
    assert.equal(view.state.sliceDoc(), "two two two");
    assert.equal(rendered.ref.current.flushPendingChanges(), true);
    assert.deepEqual(publications, ["two one one", "two two two"]);
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "one one one");
  } finally {
    rendered.cleanup();
  }
});

test("search consumes Escape only while its panel is open", async () => {
  const rendered = await renderEditor({
    initialDocument: "Select these words",
    onBufferChange() { return false; },
  });
  let bubbledEscapeCount = 0;
  const handleKeyDown = (event) => {
    if (event.key === "Escape") bubbledEscapeCount += 1;
  };
  window.addEventListener("keydown", handleKeyDown);

  try {
    const view = findEditorView(rendered.host);
    openSearchPanel(view);
    const searchField = rendered.host.querySelector('input[name="search"]');
    assert.ok(searchField);
    const panelEscape = dispatchKey(searchField, "Escape");
    assert.equal(panelEscape.defaultPrevented, true);
    assert.equal(searchPanelOpen(view.state), false);
    assert.equal(bubbledEscapeCount, 1);

    view.dispatch({ selection: { anchor: 0, head: 6 } });
    const escape = dispatchKey(view.contentDOM, "Escape", { keyCode: 27 });

    assert.equal(escape.defaultPrevented, false);
    assert.equal(bubbledEscapeCount, 2);
    assert.equal(view.state.selection.main.anchor, 0);
    assert.equal(view.state.selection.main.head, 6);
  } finally {
    window.removeEventListener("keydown", handleKeyDown);
    rendered.cleanup();
  }
});

test("IME-owned Escape does not close the search panel", async () => {
  const rendered = await renderEditor({
    initialDocument: "Composed search",
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    for (const options of [
      { isComposing: true },
      { keyCode: 229 },
    ]) {
      openSearchPanel(view);
      const searchField = rendered.host.querySelector('input[name="search"]');
      assert.ok(searchField);
      searchField.focus();
      const escape = dispatchKey(searchField, "Escape", options);
      assert.equal(escape.defaultPrevented, false);
      assert.equal(searchPanelOpen(view.state), true);
      closeSearchPanel(view);
    }
  } finally {
    rendered.cleanup();
  }
});

test("parent rerenders keep the same view, focus, selection, callback freshness, and undo history", async () => {
  const firstPublications = [];
  const secondPublications = [];
  const firstProps = {
    initialDocument: "Original",
    onBufferChange(content) {
      firstPublications.push(content);
      return true;
    },
  };
  const rendered = await renderEditor(firstProps);

  try {
    const view = findEditorView(rendered.host);
    replaceEditorDocument(view, "Changed");
    view.dispatch({ selection: { anchor: 4 } });
    view.focus();

    rendered.rerender({
      initialDocument: "Changed",
      onBufferChange(content) {
        secondPublications.push(content);
        return true;
      },
    });

    const rerenderedView = findEditorView(rendered.host);
    assert.ok(rerenderedView === view);
    assert.equal(view.state.selection.main.head, 4);
    assert.ok(document.activeElement === view.contentDOM);
    assert.equal(rendered.ref.current.flushPendingChanges(), true);
    assert.deepEqual(firstPublications, []);
    assert.deepEqual(secondPublications, ["Changed"]);

    assert.equal(undo(view), true);
    assert.equal(view.state.doc.toString(), "Original");
  } finally {
    rendered.cleanup();
  }
});

test("a clean external document refresh preserves the mounted editor and clamped selection", async () => {
  const rendered = await renderEditor({
    initialDocument: "Original words",
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: 8 } });
    view.focus();

    assert.equal(rendered.ref.current.adoptExternalDocument(
      "Original words",
      "External replacement words",
    ), true);

    assert.ok(findEditorView(rendered.host) === view);
    assert.equal(view.state.sliceDoc(), "External replacement words");
    assert.equal(view.state.selection.main.head, 8);
    assert.ok(document.activeElement === view.contentDOM);
    assert.equal(undo(view), false, "the external baseline refresh must not become an undo step");

    assert.equal(rendered.ref.current.adoptExternalDocument(
      "External replacement words",
      "Short",
    ), true);
    assert.equal(view.state.sliceDoc(), "Short");
    assert.equal(view.state.selection.main.head, 5);
  } finally {
    rendered.cleanup();
  }
});

test("ordinary parent buffer publication cannot replace newer editor input", async () => {
  const rendered = await renderEditor({
    initialDocument: "abc",
    onBufferChange() { return true; },
  });

  try {
    const view = findEditorView(rendered.host);
    replaceEditorDocument(view, "abcde");

    rendered.rerender({
      initialDocument: "abcd",
      onBufferChange() { return true; },
    });

    assert.equal(view.state.sliceDoc(), "abcde");
  } finally {
    rendered.cleanup();
  }
});

test("authoritative refresh adopts the new line separator before later edits", async () => {
  const cases = [
    {
      initial: "one\r\ntwo",
      external: "one\ntwo\nthree",
      separator: "\n",
    },
    {
      initial: "one\ntwo",
      external: "one\r\ntwo\r\nthree",
      separator: "\r\n",
    },
  ];

  for (const { initial, external, separator } of cases) {
    const rendered = await renderEditor({
      initialDocument: initial,
      onBufferChange() { return false; },
    });

    try {
      const view = findEditorView(rendered.host);
      assert.equal(rendered.ref.current.adoptExternalDocument(initial, external), true);

      assert.equal(view.state.lineBreak, separator);
      assert.equal(view.state.doc.lines, 3);
      assert.equal(view.state.sliceDoc(), external);

      view.dispatch({
        changes: { from: view.state.doc.length, insert: `${view.state.lineBreak}four` },
      });
      assert.equal(view.state.sliceDoc(), `${external}${separator}four`);
    } finally {
      rendered.cleanup();
    }
  }
});

test("authoritative refresh rejects newer editor input and publishes it synchronously", async () => {
  const publications = [];
  const rendered = await renderEditor({
    initialDocument: "Clean baseline",
    onBufferChange(content) {
      publications.push(content);
      return true;
    },
  });

  try {
    const view = findEditorView(rendered.host);
    replaceEditorDocument(view, "Newer local typing");

    assert.equal(rendered.ref.current.adoptExternalDocument(
      "Clean baseline",
      "External replacement",
    ), false);
    assert.equal(view.state.sliceDoc(), "Newer local typing");
    assert.deepEqual(publications, ["Newer local typing"]);
  } finally {
    rendered.cleanup();
  }
});

test("authoritative refresh clears undo and redo history from the old baseline", async () => {
  const rendered = await renderEditor({
    initialDocument: "Original",
    onBufferChange() { return true; },
  });

  try {
    const view = findEditorView(rendered.host);
    replaceEditorDocument(view, "Saved local edit");
    assert.equal(rendered.ref.current.flushPendingChanges(), true);

    assert.equal(rendered.ref.current.adoptExternalDocument(
      "Saved local edit",
      "External replacement",
    ), true);
    assert.equal(undo(view), false);
    assert.equal(view.state.sliceDoc(), "External replacement");
  } finally {
    rendered.cleanup();
  }
});

test("formatting toggles preserve document, selection, undo history, and publication state", async () => {
  const publications = [];
  const baseProps = {
    initialDocument: "Original",
    fileType: "markdown",
    onBufferChange(content) {
      publications.push(content);
      return true;
    },
  };
  const rendered = await renderEditor({
    ...baseProps,
    markdownFormattingEnabled: true,
  });

  try {
    const view = findEditorView(rendered.host);
    replaceEditorDocument(view, "Changed");
    await waitForPublication();
    publications.length = 0;
    view.dispatch({ selection: { anchor: 2, head: 6 } });

    for (const enabled of [false, true, false]) {
      rendered.rerender({ ...baseProps, markdownFormattingEnabled: enabled });
      assert.ok(findEditorView(rendered.host) === view);
      assert.equal(view.state.field(markdownFormattingEnabled), enabled);
      assert.equal(view.state.sliceDoc(), "Changed");
      assert.equal(view.state.selection.main.anchor, 2);
      assert.equal(view.state.selection.main.head, 6);
    }

    await waitForPublication();
    assert.deepEqual(publications, []);
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), "Original");
  } finally {
    rendered.cleanup();
  }
});

test("fresh Markdown sessions honor their initial formatting preference", async () => {
  const rendered = await renderEditor({
    initialDocument: "# Plain",
    fileType: "markdown",
    markdownFormattingEnabled: false,
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    assert.equal(view.state.field(markdownFormattingEnabled), false);
  } finally {
    rendered.cleanup();
  }
});

test("background parser advances refresh visible heading decorations without another edit or scroll", async () => {
  // This fixture is intentionally larger than CodeMirror's synchronous parse
  // budget. The test environment's parse worker uses a 500ms timer, so the two
  // layout frames below settle scrolling without advancing the background tree.
  const prefix = "plain\n".repeat(100_000);
  const initialDocument = `${prefix}# Target\n`;
  const rendered = await renderEditor({
    initialDocument,
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    const countDecorations = () => {
      let count = 0;
      view.plugin(markdownHeadingViewPlugin).decorations.between(
        0,
        view.state.doc.length,
        () => { count += 1; },
      );
      return count;
    };

    view.dispatch({
      selection: { anchor: initialDocument.length - 2 },
      effects: EditorView.scrollIntoView(initialDocument.length - 2, { y: "center" }),
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });

    const incompleteTree = syntaxTree(view.state);
    assert.ok(
      incompleteTree.length < view.state.doc.length,
      "fixture must remain partially parsed before forceParsing",
    );
    assert.equal(countDecorations(), 0);
    assert.equal(forceParsing(view, view.state.doc.length, 10_000), true);
    assert.ok(syntaxTree(view.state) !== incompleteTree);
    assert.equal(countDecorations(), 2);
  } finally {
    rendered.cleanup();
  }
});

test("Fountain sessions do not install Markdown formatting state", async () => {
  const rendered = await renderEditor({
    initialDocument: "INT. OFFICE - DAY\n\n# Not Markdown",
    fileType: "fountain",
    markdownFormattingEnabled: true,
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    assert.equal(view.contentDOM.getAttribute("aria-label"), "Edit document");
    assert.equal(view.state.field(markdownFormattingEnabled, false), undefined);
  } finally {
    rendered.cleanup();
  }
});

test("file type transitions are explicit keyed session boundaries", async () => {
  const rendered = await renderEditor({
    initialDocument: "# Markdown",
    fileType: "markdown",
    onBufferChange() { return false; },
  }, { key: "markdown-session" });

  try {
    const markdownView = findEditorView(rendered.host);
    assert.equal(markdownView.state.field(markdownFormattingEnabled), true);

    rendered.rerender({
      initialDocument: "INT. OFFICE - DAY\n\n# Fountain",
      fileType: "fountain",
      markdownFormattingEnabled: true,
      onBufferChange() { return false; },
    }, "fountain-session");

    const fountainView = findEditorView(rendered.host);
    assert.ok(fountainView !== markdownView);
    assert.equal(fountainView.state.field(markdownFormattingEnabled, false), undefined);
  } finally {
    rendered.cleanup();
  }
});

test("a new edit session gets a fresh state and an old session timer cannot publish", async () => {
  const publications = [];
  const rendered = await renderEditor({
    initialDocument: "First",
    onBufferChange(content) {
      publications.push(content);
      return true;
    },
  }, { key: "first" });

  try {
    const firstView = findEditorView(rendered.host);
    replaceEditorDocument(firstView, "First changed");
    openSearchPanel(firstView);
    assert.equal(searchPanelOpen(firstView.state), true);

    rendered.rerender({
      initialDocument: "Second",
      onBufferChange(content) {
        publications.push(content);
        return true;
      },
    }, "second");
    const secondView = findEditorView(rendered.host);

    assert.ok(secondView !== firstView);
    assert.equal(secondView.state.doc.toString(), "Second");
    assert.equal(searchPanelOpen(secondView.state), false);
    assert.ok(!rendered.host.querySelector(".cm-panel"));
    assert.equal(undo(secondView), false);
    await waitForPublication();
    assert.deepEqual(publications, []);
  } finally {
    rendered.cleanup();
  }
});

test("uniform line endings round-trip and mixed line endings normalize deliberately", async () => {
  const cases = [
    ["one\ntwo\n", "one\ntwo\n"],
    ["one\r\ntwo\r\n", "one\r\ntwo\r\n"],
    ["one\rtwo\r", "one\rtwo\r"],
    ["one\r\ntwo\nthree\r\n", "one\r\ntwo\r\nthree\r\n"],
  ];

  for (const [initialDocument, expectedDocument] of cases) {
    const rendered = await renderEditor({
      initialDocument,
      onBufferChange() { return true; },
    });
    try {
      assert.equal(findEditorView(rendered.host).state.sliceDoc(), expectedDocument);
    } finally {
      rendered.cleanup();
    }
  }
});

test("search replacement preserves CRLF and CR line separators", async () => {
  for (const [initialDocument, expectedDocument] of [
    ["one\r\none\r\n", "two\r\ntwo\r\n"],
    ["one\rone\r", "two\rtwo\r"],
  ]) {
    const rendered = await renderEditor({
      initialDocument,
      onBufferChange() { return true; },
    });
    try {
      const view = findEditorView(rendered.host);
      openSearchPanel(view);
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "one", replace: "two" })),
      });
      assert.equal(replaceAll(view), true);
      assert.equal(view.state.sliceDoc(), expectedDocument);
      assert.equal(undo(view), true);
      assert.equal(view.state.sliceDoc(), initialDocument);
    } finally {
      rendered.cleanup();
    }
  }
});

test("an edited-then-undone mixed-ending document publishes its normalized form as dirty", async () => {
  const initialDocument = "one\r\ntwo\n";
  const normalizedDocument = "one\r\ntwo\r\n";
  let publishedDocument = null;
  const rendered = await renderEditor({
    initialDocument,
    onBufferChange(content) {
      publishedDocument = content;
      return content !== initialDocument;
    },
  });

  try {
    const view = findEditorView(rendered.host);
    assert.equal(view.state.sliceDoc(), normalizedDocument);
    assert.equal(publishedDocument, null, "mounting alone must not publish normalization");

    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), normalizedDocument);
    assert.equal(rendered.ref.current.flushPendingChanges(), true);
    assert.equal(publishedDocument, normalizedDocument);
  } finally {
    rendered.cleanup();
  }
});

test("large documents publish without truncation", async () => {
  const initialDocument = `${"0123456789abcdef".repeat(65_536)}\n`;
  let published = null;
  const rendered = await renderEditor({
    initialDocument,
    onBufferChange(content) {
      published = content;
      return true;
    },
  });

  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "終" } });
    assert.equal(rendered.ref.current.flushPendingChanges(), true);
    assert.equal(published, `${initialDocument}終`);
  } finally {
    rendered.cleanup();
  }
});

test("initial source positioning is clamped, applied once, and captured without mutation", async () => {
  const initialDocument = "# Intro\r\n😀 target\r\nLast";
  const rendered = await renderEditor({
    initialDocument,
    initialPosition: { line: 2, column: 3 },
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    const expectedOffset = view.state.doc.line(2).from + 2;
    assert.equal(view.state.selection.main.head, expectedOffset);
    const before = {
      doc: view.state.sliceDoc(),
      selection: view.state.selection.main.toJSON(),
      activeElement: document.activeElement,
    };
    assert.deepEqual(rendered.ref.current.capturePosition().cursor, { line: 2, column: 3 });
    assert.equal(view.state.sliceDoc(), before.doc);
    assert.deepEqual(view.state.selection.main.toJSON(), before.selection);
    assert.ok(document.activeElement === before.activeElement);

    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
    rendered.rerender({
      initialDocument,
      initialPosition: { line: 1, column: 1 },
      onBufferChange() { return false; },
    });
    assert.ok(findEditorView(rendered.host) === view);
    assert.deepEqual(rendered.ref.current.capturePosition().cursor, { line: 3, column: 1 });
    assert.equal(undo(view), false, "selection capture and initial positioning must not add history");
  } finally {
    rendered.cleanup();
  }
});

test("scroll-only movement captures the first visible editor line without moving selection", async () => {
  await installDom();
  const scrollRootRef = setScrollRoot({ top: 0, bottom: 400 });
  const rendered = await renderEditor({
    initialDocument: "First\nSecond\nThird",
    initialPosition: { line: 1, column: 1 },
    scrollRootRef,
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    await settleFrames();
    assert.equal(rendered.ref.current.capturePosition().viewportMoved, false);

    const lines = view.contentDOM.querySelectorAll(".cm-line");
    lines.forEach((line, index) => {
      const top = index === 2 ? 100 : -200 + index * 20;
      line.getBoundingClientRect = () => ({
        x: 0, y: top, top, bottom: top + 20, left: 0, right: 300,
        width: 300, height: 20, toJSON() {},
      });
    });
    view.posAtCoords = () => null;
    document.body.scrollTop = 500;
    document.body.dispatchEvent(new window.Event("scroll"));

    const beforeSelection = view.state.selection.main.toJSON();
    const captured = rendered.ref.current.capturePosition();
    assert.deepEqual(captured, {
      cursor: { line: 1, column: 1 },
      viewport: { line: 3, column: 1 },
      viewportMoved: true,
    });
    assert.deepEqual(view.state.selection.main.toJSON(), beforeSelection);
  } finally {
    rendered.cleanup();
  }
});

function settleFrames() {
  return act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

function setScrollRoot(rect) {
  Object.defineProperty(document.body, "scrollTop", { value: 0, writable: true, configurable: true });
  document.body.getBoundingClientRect = () => ({
    x: 0, y: rect.top, left: 0, right: 800, width: 800, height: rect.bottom - rect.top, toJSON() {}, ...rect,
  });
  return { current: document.body };
}

test("the view counts as moved only after the user scrolls it", async () => {
  await installDom();
  const scrollRootRef = setScrollRoot({ top: 0, bottom: 400 });
  const rendered = await renderEditor({
    initialDocument: "First\nSecond",
    initialPosition: { line: 2, column: 1 },
    scrollRootRef,
    onBufferChange() { return false; },
  });

  try {
    // The editor positions the shared scroll root during its own layout pass.
    // Its scroll event is not the user's.
    findEditorView(rendered.host).requestMeasure({
      read() {},
      write() { document.body.scrollTop = 300; },
    });
    await settleFrames();
    document.body.dispatchEvent(new window.Event("scroll"));
    assert.equal(rendered.ref.current.capturePosition().viewportMoved, false);

    document.body.scrollTop = 700;
    document.body.dispatchEvent(new window.Event("scroll"));
    assert.equal(rendered.ref.current.capturePosition().viewportMoved, true);
  } finally {
    rendered.cleanup();
  }
});

test("the editor opens on Read's screen height below the bar, and centres without one", async () => {
  const original = EditorView.scrollIntoView;
  const scrolls = [];
  EditorView.scrollIntoView = (position, options) => {
    scrolls.push({ position, ...options });
    return original(position, options);
  };
  try {
    for (const [label, initialScreenTopPx, withBar, expected] of [
      ["Read's height", 250, true, { y: "start", yMargin: 250 - 50 - 58 }],
      ["floored at the stuck bar", 80, true, { y: "start", yMargin: 0 }],
      ["no Read height", null, true, { y: "center" }],
      ["no formatting bar", 250, false, { y: "center" }],
    ]) {
      await installDom();
      scrolls.length = 0;
      // Main's top is 50 on screen; the 58-px bar sits at rest at its top.
      const scrollRootRef = setScrollRoot({ top: 50, bottom: 450 });
      const bar = document.createElement("div");
      const controls = document.createElement("div");
      bar.appendChild(controls);
      document.body.appendChild(bar);
      bar.style.top = "0px";
      Object.defineProperty(bar, "offsetHeight", { value: 58 });
      bar.getBoundingClientRect = () => ({
        x: 0, y: 50, top: 50, bottom: 108, left: 0, right: 800, width: 800, height: 58, toJSON() {},
      });
      const rendered = await renderEditor({
        initialDocument: "# Title\n\nFirst\n\nReading here",
        initialPosition: { line: 5, column: 1 },
        initialScreenTopPx,
        scrollRootRef,
        formattingControlsRef: withBar ? { current: controls } : undefined,
        onBufferChange() { return false; },
      });
      try {
        const view = findEditorView(rendered.host);
        await settleFrames();
        const anchor = view.state.doc.line(5).from;
        assert.deepEqual(scrolls, [{ position: anchor, ...expected }], label);
        assert.equal(view.state.selection.main.head, anchor, label);
        assert.equal(rendered.ref.current.capturePosition().viewportMoved, false, label);
        assert.equal(undo(view), false, `${label}: the initial scroll adds no history`);
      } finally {
        rendered.cleanup();
        bar.remove();
      }
    }
  } finally {
    EditorView.scrollIntoView = original;
  }
});

for (const [label, initialDocument, line] of [
  ["the visible editor line is read below the sticky formatting controls", "Covered\nVisible\nBelow", 2],
  ["a blank line just below the sticky controls yields the next visible text", "Covered\n\nVisible", 3],
]) test(label, async () => {
  await installDom();
  const scrollRootRef = setScrollRoot({ top: 0, bottom: 400 });
  const bar = document.createElement("div");
  const controls = document.createElement("div");
  bar.appendChild(controls);
  document.body.appendChild(bar);
  bar.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, bottom: 100, left: 0, right: 800, width: 800, height: 100, toJSON() {},
  });
  const rendered = await renderEditor({
    initialDocument,
    initialPosition: { line: 1, column: 1 },
    scrollRootRef,
    formattingControlsRef: { current: controls },
    onBufferChange() { return false; },
  });

  try {
    const view = findEditorView(rendered.host);
    await settleFrames();
    const tops = [40, 110, 140];
    view.contentDOM.querySelectorAll(".cm-line").forEach((line, index) => {
      const top = tops[index];
      line.getBoundingClientRect = () => ({
        x: 0, y: top, top, bottom: top + 30, left: 0, right: 300, width: 300, height: 30, toJSON() {},
      });
    });
    view.posAtCoords = () => null;
    document.body.scrollTop = 500;
    document.body.dispatchEvent(new window.Event("scroll"));

    assert.deepEqual(rendered.ref.current.capturePosition(), {
      cursor: { line: 1, column: 1 },
      viewport: { line, column: 1 },
      viewportMoved: true,
    });
  } finally {
    rendered.cleanup();
    bar.remove();
  }
});

test("a fresh editor session receives its own clamped initial source point", async () => {
  const rendered = await renderEditor({
    initialDocument: "First\nSecond",
    initialPosition: { line: 99, column: 99 },
    onBufferChange() { return false; },
  }, { key: "first-position" });

  try {
    assert.deepEqual(rendered.ref.current.capturePosition().cursor, { line: 2, column: 7 });
    const firstView = findEditorView(rendered.host);
    rendered.rerender({
      initialDocument: "New",
      initialPosition: { line: 1, column: 2 },
      onBufferChange() { return false; },
    }, "second-position");
    assert.ok(findEditorView(rendered.host) !== firstView);
    assert.deepEqual(rendered.ref.current.capturePosition().cursor, { line: 1, column: 2 });
  } finally {
    rendered.cleanup();
  }
});

for (const formatting of [true, false]) {
  for (const initialDocument of ['- first', '1. first', '- [ ] first']) {
    test(`list continuation exits the empty item with formatting=${formatting}: ${initialDocument}`, async () => {
      const rendered = await renderEditor({ initialDocument, markdownFormattingEnabled: formatting, onBufferChange() { return true; } });
      try {
        const view = findEditorView(rendered.host);
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        dispatchKey(view.contentDOM, 'Enter');
        const continued = view.state.doc.toString();
        assert.match(continued, /\n(?:- |2\. |- \[ \] )$/);
        assert.equal(undo(view), true);
        assert.equal(view.state.doc.toString(), initialDocument);
        dispatchKey(view.contentDOM, 'Enter');
        dispatchKey(view.contentDOM, 'Enter');
        assert.equal(view.state.doc.toString(), `${initialDocument}\n\n`);
        view.dispatch(view.state.replaceSelection("foo"));
        const { markdownArticle } = require("./_helpers/markdown-reader.cjs");
        const article = markdownArticle(view.state.sliceDoc());
        const paragraph = [...article.querySelectorAll("p")].find((node) => node.textContent === "foo");
        assert.ok(paragraph, article.innerHTML);
        assert.equal(paragraph.closest("li"), null, article.innerHTML);
      } finally { rendered.cleanup(); }
    });
  }
}
test('Fountain Enter does not apply Markdown list continuation', async () => {
  const rendered = await renderEditor({ initialDocument: '- action', fileType: 'fountain', onBufferChange() { return true; } });
  try {
    const view = findEditorView(rendered.host); view.dispatch({ selection: { anchor: view.state.doc.length } });
    dispatchKey(view.contentDOM, 'Enter'); assert.equal(view.state.doc.toString(), '- action\n');
  } finally { rendered.cleanup(); }
});

for (const formatting of [true, false]) {
  test(`empty nested item outdents before exit; publication and Undo, styled=${formatting}`, async () => {
    const publications = [];
    const rendered = await renderEditor({ initialDocument: '- a\n  - ', markdownFormattingEnabled: formatting,
      onBufferChange(content) { publications.push(content); return true; } });
    try {
      const view = findEditorView(rendered.host);
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      dispatchKey(view.contentDOM, 'Enter');
      assert.equal(view.state.sliceDoc(), '- a\n- ');
      dispatchKey(view.contentDOM, 'Enter');
      assert.equal(view.state.sliceDoc(), '- a\n\n');
      assert.equal(undo(view), true);
      assert.equal(view.state.sliceDoc(), '- a\n- ');
      dispatchKey(view.contentDOM, 'Enter');
      view.dispatch({ ...view.state.replaceSelection('foo'), userEvent: 'input.type' });
      assert.equal(rendered.ref.current.flushPendingChanges(), true);
      assert.deepEqual(publications, ['- a\n\nfoo']);
      await waitForPublication();
      assert.equal(publications.length, 1);
      view.dispatch({ ...view.state.replaceSelection(' bar'), userEvent: 'input.type' });
      await waitForPublication();
      assert.equal(publications.at(-1), '- a\n\nfoo bar');
    } finally { rendered.cleanup(); }
  });
}

test('numbered Enter continues intentional starts and renumbers the following run', async () => {
  const rendered = await renderEditor({ initialDocument: '10) a\n11) b\n12) c', onBufferChange() { return true; } });
  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: 5 } });
    dispatchKey(view.contentDOM, 'Enter');
    assert.equal(view.state.sliceDoc(), '10) a\n11) \n12) b\n13) c');
  } finally { rendered.cleanup(); }
});

for (const formatting of [true, false]) {
  test(`existing indentation shortcuts are list-aware; generic and focus keys remain intact, styled=${formatting}`, async () => {
    const publications = [];
    const rendered = await renderEditor({ initialDocument: '10. parent\n11. [x] child', markdownFormattingEnabled: formatting,
      onBufferChange(content) { publications.push(content); return true; } });
    try {
      const view = findEditorView(rendered.host);
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      assert.equal(dispatchKey(view.contentDOM, ']', { ctrlKey: true }).defaultPrevented, true);
      assert.equal(view.state.sliceDoc(), '10. parent\n    1. [x] child');
      assert.equal(rendered.ref.current.flushPendingChanges(), true);
      assert.deepEqual(publications, ['10. parent\n    1. [x] child']);
      dispatchKey(view.contentDOM, '[', { ctrlKey: true });
      assert.equal(view.state.sliceDoc(), '10. parent\n11. [x] child');
      view.dispatch({ selection: { anchor: 5 } });
      dispatchKey(view.contentDOM, ']', { ctrlKey: true });
      assert.equal(view.state.sliceDoc(), '10. parent\n11. [x] child', 'first item must not fall through to fixed indent');
      assert.equal(dispatchKey(view.contentDOM, 'Tab').defaultPrevented, false);
      assert.equal(dispatchKey(view.contentDOM, 'Tab', { shiftKey: true }).defaultPrevented, false);
      assert.equal(dispatchKey(view.contentDOM, 'Escape').defaultPrevented, false);
      replaceEditorDocument(view, 'ordinary');
      view.dispatch({ selection: { anchor: 3 } });
      dispatchKey(view.contentDOM, ']', { ctrlKey: true });
      assert.equal(view.state.sliceDoc(), '  ordinary');
      dispatchKey(view.contentDOM, '[', { ctrlKey: true });
      assert.equal(view.state.sliceDoc(), 'ordinary');
    } finally { rendered.cleanup(); }
  });
}

test('Fountain keeps generic indentation even for Markdown-looking text', async () => {
  const rendered = await renderEditor({ initialDocument: '10. parent\n11. child', fileType: 'fountain', onBufferChange() { return true; } });
  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    dispatchKey(view.contentDOM, ']', { ctrlKey: true });
    assert.equal(view.state.sliceDoc(), '10. parent\n  11. child');
  } finally { rendered.cleanup(); }
});

for (const formatting of [true, false]) {
  test(`ordered tasks continue unchecked and exit into a paragraph, styled=${formatting}`, async () => {
    const rendered = await renderEditor({ initialDocument: '10) [x] a', markdownFormattingEnabled: formatting, onBufferChange() { return true; } });
    try {
      const view = findEditorView(rendered.host);
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      dispatchKey(view.contentDOM, 'Enter');
      assert.equal(view.state.sliceDoc(), '10) [x] a\n11) [ ] ');
      dispatchKey(view.contentDOM, 'Enter');
      view.dispatch(view.state.replaceSelection('foo'));
      assert.equal(view.state.sliceDoc(), '10) [x] a\n\nfoo');
      const { markdownArticle } = require('./_helpers/markdown-reader.cjs');
      const article = markdownArticle(view.state.sliceDoc());
      assert.equal(article.lastElementChild.tagName, 'P');
      assert.equal(article.lastElementChild.textContent, 'foo');
      assert.equal(article.querySelectorAll('input[checked]').length, 1);
    } finally { rendered.cleanup(); }
  });
}

test('ordered empty nested tasks outdent once and list exit retains CRLF and CR serialization', async () => {
  for (const separator of ['\r\n', '\r']) {
    const rendered = await renderEditor({ initialDocument: `10. [x] parent${separator}    1. [ ] `, onBufferChange() { return true; } });
    try {
      const view = findEditorView(rendered.host);
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      dispatchKey(view.contentDOM, 'Enter');
      assert.equal(view.state.sliceDoc(), `10. [x] parent${separator}11. [ ] `);
      dispatchKey(view.contentDOM, 'Enter');
      assert.equal(view.state.sliceDoc(), `10. [x] parent${separator}${separator}`);
      assert.equal(undo(view), true);
      assert.equal(view.state.sliceDoc(), `10. [x] parent${separator}11. [ ] `);
    } finally { rendered.cleanup(); }
  }
});

for (const formatting of [true, false]) {
  test(`middle list exit keeps both surrounding lists separate, styled=${formatting}`, async () => {
    for (const [initialDocument, expected] of [
      ['3. a\n4. \n5. c', '3. a\n\nfoo\n\n4. c'],
      ['10) [x] a\n11) [ ] \n12) [x] b', '10) [x] a\n\nfoo\n\n11) [x] b'],
      ['3. a\n\n4. \n5. c', '3. a\n\nfoo\n\n4. c'],
    ]) {
      const rendered = await renderEditor({ initialDocument, markdownFormattingEnabled: formatting,
        onBufferChange() { return true; } });
      try {
        const view = findEditorView(rendered.host);
        view.dispatch({ selection: { anchor: view.state.doc.line(view.state.doc.lines - 1).to } });
        assert.equal(dispatchKey(view.contentDOM, 'Enter').defaultPrevented, true);
        const exited = view.state.sliceDoc();
        const caret = view.state.selection.main.head;
        assert.equal(undo(view), true);
        assert.equal(view.state.sliceDoc(), initialDocument);
        assert.equal(redo(view), true);
        assert.equal(view.state.sliceDoc(), exited);
        assert.equal(view.state.selection.main.head, caret);
        view.dispatch(view.state.replaceSelection('foo'));
        assert.equal(view.state.sliceDoc(), expected);
        const { markdownArticle } = require('./_helpers/markdown-reader.cjs');
        const article = markdownArticle(view.state.sliceDoc());
        assert.deepEqual([...article.children].map((node) => node.tagName), ['OL', 'P', 'OL']);
        assert.equal(article.children[1].textContent, 'foo');
        assert.equal(article.querySelectorAll('input[checked]').length, initialDocument.includes('[x]') ? 2 : 0);
      } finally { rendered.cleanup(); }
    }
  });

  test(`command-created empty nested tasks outdent with checked state intact, styled=${formatting}`, async () => {
    const { applyListCommand } = require('../.tmp/workspace-tests/src/components/markdown-formatting-commands.js');
    for (const [parent, child, expected] of [
      ['- [x] parent', '  - child', '- [x] parent\n\n1. [ ] '],
      ['- parent', '  - child', '- parent\n\n1. [ ] '],
      ['10. [x] parent', '    1. [x] child', '10. [x] parent\n11. [x] '],
      ['10. [x] parent', '    1. [X] child', '10. [x] parent\n11. [X] '],
      ['- parent', '  - [X] child', '- parent\n- [X] '],
    ]) {
      const publications = [];
      const rendered = await renderEditor({ initialDocument: `${parent}\n${child}`, markdownFormattingEnabled: formatting,
        onBufferChange(content) { publications.push(content); return true; } });
      try {
        const view = findEditorView(rendered.host);
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        if (child.includes('- child')) {
          assert.equal(applyListCommand(view, 'numbered').applied, true);
          assert.equal(applyListCommand(view, 'checklist').applied, true);
        }
        view.dispatch({ changes: { from: view.state.doc.length - 'child'.length, to: view.state.doc.length } });
        const before = view.state.sliceDoc();
        assert.equal(dispatchKey(view.contentDOM, 'Enter').defaultPrevented, true);
        assert.equal(view.state.sliceDoc(), expected);
        assert.equal(undo(view), true);
        assert.equal(view.state.sliceDoc(), before);
        assert.equal(redo(view), true);
        view.dispatch(view.state.replaceSelection('foo'));
        assert.equal(view.state.sliceDoc(), `${expected}foo`);
        const { markdownArticle } = require('./_helpers/markdown-reader.cjs');
        const article = markdownArticle(view.state.sliceDoc());
        assert.equal(article.querySelectorAll('li li').length, 0, article.innerHTML);
        assert.equal(article.querySelectorAll('input[type="checkbox"]').length, parent.includes('[x]') ? 2 : 1);
        assert.equal(rendered.ref.current.flushPendingChanges(), true);
        assert.equal(publications.at(-1), `${expected}foo`);
      } finally { rendered.cleanup(); }
    }
  });
}

test('indent shortcut routing honors half-open selections and inspects every selection range', async () => {
  const { EditorSelection } = require('@codemirror/state');
  const rendered = await renderEditor({ initialDocument: 'plain\n- parent\n- child', onBufferChange() { return true; } });
  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: EditorSelection.single(0, 6) });
    dispatchKey(view.contentDOM, ']', { ctrlKey: true });
    assert.equal(view.state.sliceDoc(), '  plain\n- parent\n- child');
    assert.equal(undo(view), true);
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(view.state.doc.length)], 0) });
    const before = view.state;
    dispatchKey(view.contentDOM, ']', { ctrlKey: true });
    assert.equal(view.state, before, 'a second range in a list must refuse without generic fallback');
  } finally { rendered.cleanup(); }
});

test('empty task Enter consumes refused outdent without falling through to generic newline', async () => {
  const initialDocument = '- parent\n  1. [ ] \n  2. sibling';
  const rendered = await renderEditor({ initialDocument, onBufferChange() { return true; } });
  try {
    const view = findEditorView(rendered.host);
    view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
    assert.equal(dispatchKey(view.contentDOM, 'Enter').defaultPrevented, true);
    assert.equal(view.state.sliceDoc(), initialDocument);
    assert.equal(undo(view), false);
  } finally { rendered.cleanup(); }
});
