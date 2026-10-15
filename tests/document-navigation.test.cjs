const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { mockIPC, clearMocks } = require("@tauri-apps/api/mocks");
const {
  useWorkspaceIndex,
} = require("../.tmp/workspace-tests/src/hooks/useWorkspaceIndex.js");
const {
  searchWorkspaceDocs,
} = require("../.tmp/workspace-tests/src/lib/workspace-search.js");
const {
  prepareCatalogDocument,
} = require("../.tmp/workspace-tests/src/lib/document-catalog.js");
const {
  buildSearchCache,
} = require("../.tmp/workspace-tests/src/lib/search-cache.js");
const {
  highlightSearchMatches,
  useSearch,
} = require("../.tmp/workspace-tests/src/hooks/useSearch.js");
const meta = (path, mtimeMs = 1) => ({
  path,
  name: path.split("/").pop(),
  relPath: path.split("/").pop(),
  size: 10,
  mtimeMs,
});
const listing = (files) => ({
  files,
  directories: [],
  skippedCount: 0,
  limitHit: false,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
async function until(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await settle();
    try {
      fn();
      return;
    } catch (e) {
      if (i === tries - 1) throw e;
    }
  }
}
async function mount(
  t,
  rootPath = "/folder",
  recents = [],
  showSidebar = false,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let api;
  function Probe({ path }) {
    api = useWorkspaceIndex(path, recents);
    if (!showSidebar) return null;
    const {
      Sidebar,
    } = require("../.tmp/workspace-tests/src/components/Sidebar.js");
    const {
      ToastProvider,
    } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
    return React.createElement(
      ToastProvider,
      null,
      React.createElement(Sidebar, {
        visible: true,
        recentFiles: recents,
        currentFilePath: null,
        openingPath: null,
        workspaceRootPath: path,
        workspaceState: api.state,
        docs: api.docs,
        onChooseWorkspaceRoot() {},
        onClearWorkspaceRoot() {},
        onOpenRecent() {},
        onRemoveRecent() {},
        onReindexWorkspace() {},
        onShowDrafts: api.showDrafts,
        onOpenWorkspacePath() {},
        onOpenCommandPalette() {},
      }),
    );
  }
  const render = async (path) => {
    await act(async () => root.render(React.createElement(Probe, { path })));
  };
  await render(rootPath);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    clearMocks();
  });
  return { get: () => api, render, host };
}
function ipc(overrides = {}) {
  mockIPC((cmd, args) => {
    if (overrides[cmd]) return overrides[cmd](args);
    if (cmd === "load_search_cache") return null;
    if (cmd === "save_search_cache") return;
    if (cmd === "list_draft_documents") return listing([]);
    if (cmd === "inspect_document_files") return [];
    if (cmd === "list_workspace_markdown_files")
      return listing([meta("/folder/a.md")]);
    if (cmd === "read_markdown_file") return "# A\n\nOriginal passage";
    throw new Error(cmd);
  });
}
test("discovery is published before reads and failures retain filename search", async (t) => {
  const gate = deferred();
  ipc({ read_markdown_file: () => gate.promise });
  const view = await mount(t);
  await until(() => assert.equal(view.get().docs[0]?.coverage, "pending"));
  await act(async () =>
    gate.resolve(
      Promise.reject({
        category: "permissionDenied",
        operation: "readDocument",
        message: "Permission denied",
        detail: "",
      }),
    ),
  );
  await until(() => assert.equal(view.get().state.status, "ready"));
  assert.equal(view.get().docs[0].coverage, "unreadable");
  assert.equal(
    searchWorkspaceDocs(view.get().docs, "a.md", new Map()).length,
    1,
  );
});
test("drafts exist outside Recent, sources deduplicate and unchanged reconciliation avoids parsing", async (t) => {
  let reads = 0,
    folderVersion = 1;
  ipc({
    list_draft_documents: () => listing([meta("/draft/old.md")]),
    inspect_document_files: () => [meta("/folder/a.md", folderVersion)],
    list_workspace_markdown_files: () =>
      listing([meta("/folder/a.md", folderVersion)]),
    read_markdown_file: ({ path }) => {
      reads++;
      return path.includes("old") ? "An old draft" : "# A\n\nChanged text";
    },
  });
  const view = await mount(t, "/folder", [
    { path: "/folder/a.md", name: "a.md", openedAt: 1 },
  ]);
  await until(() => assert.equal(view.get().state.status, "ready"));
  assert.equal(view.get().docs.length, 2);
  assert.deepEqual(
    view.get().docs.find((d) => d.path === "/folder/a.md").sources,
    ["folder", "recent"],
  );
  assert.equal(
    view.get().docs.find((d) => d.path === "/draft/old.md").draftLabel,
    "An old draft",
  );
  const before = reads,
    checkedAt = view.get().state.indexedAt,
    parsed = view.get().docs.find((d) => d.path === "/folder/a.md");
  await act(async () => view.get().reconcile());
  await until(() => assert.ok(view.get().state.indexedAt > checkedAt));
  assert.equal(reads, before);
  // The same object, so caches keyed on identity still hit.
  assert.equal(
    view.get().docs.find((d) => d.path === "/folder/a.md"),
    parsed,
  );
  folderVersion = 2;
  await act(async () => view.get().reconcile());
  await until(() => assert.equal(reads, before + 1));
  assert.notEqual(
    view.get().docs.find((d) => d.path === "/folder/a.md"),
    parsed,
  );
});
test("confirmed save is searchable immediately and a late read cannot overwrite it", async (t) => {
  const gate = deferred();
  let version = 1;
  ipc({
    read_markdown_file: () => gate.promise,
    list_workspace_markdown_files: () =>
      listing([
        { ...meta("/folder/a.md", version), size: version === 1 ? 10 : 16 },
      ]),
  });
  const view = await mount(t);
  await until(() => assert.equal(view.get().docs[0]?.coverage, "pending"));
  version = 2;
  await act(async () =>
    view.get().updateSaved("/folder/a.md", "New saved nebula", {
      size: 16,
      mtimeMs: 2,
      contentHash: "revision-only",
      folderId: "revision-only",
    }),
  );
  assert.equal(
    searchWorkspaceDocs(view.get().docs, "nebula", new Map()).length,
    1,
  );
  assert.ok(
    !("contentHash" in view.get().docs[0]) && !("folderId" in view.get().docs[0]),
    "only catalog fields are copied from a saved revision",
  );
  await act(async () => gate.resolve("Old text"));
  await settle();
  assert.equal(
    searchWorkspaceDocs(view.get().docs, "nebula", new Map()).length,
    1,
  );
});
for (const next of [null, "/replacement"])
  test(`late discovery cannot republish removed folder: ${next}`, async (t) => {
    const gate = deferred();
    ipc({
      list_workspace_markdown_files: ({ root }) =>
        root === "/folder"
          ? gate.promise
          : listing([meta("/replacement/b.md")]),
    });
    const view = await mount(t);
    await view.render(next);
    await until(() => assert.equal(view.get().state.status, "ready"));
    await act(async () => gate.resolve(listing([meta("/folder/a.md")])));
    await settle();
    assert.ok(!view.get().docs.some((d) => d.path.startsWith("/folder/")));
    assert.equal(view.get().state.rootPath, next);
  });
test("cache failures do not prevent document discovery or reading", async (t) => {
  ipc({
    load_search_cache: () => {
      throw Error("broken cache");
    },
    save_search_cache: () => {
      throw Error("disk full");
    },
  });
  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"));
  assert.equal(view.get().docs.length, 1);
});

test("an old extraction cache reprocesses unchanged footnotes and stays corrected after refresh", async (t) => {
  const file = meta("/folder/footnote.md");
  const content = "Read this note[^1].\n\n[^1]: Refund policy applies.";
  file.size = Buffer.byteLength(content);
  const fresh = prepareCatalogDocument(file, content);
  const stale = { ...fresh, bodyText: `${fresh.bodyText} ↩` };
  let cache = { version: 1, docs: [stale] };
  let reads = 0;
  let writes = 0;
  ipc({
    load_search_cache: () => structuredClone(cache),
    save_search_cache: ({ cache: updated }) => {
      cache = structuredClone(updated);
      writes++;
    },
    list_workspace_markdown_files: () => listing([file]),
    read_markdown_file: () => {
      reads++;
      return content;
    },
  });

  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"));
  assert.equal(
    reads,
    1,
    "unchanged metadata cannot validate old extracted text",
  );
  assert.equal(view.get().docs[0].bodyText, fresh.bodyText);
  assert.equal(cache.version, 2);
  assert.equal(cache.docs[0].bodyText, fresh.bodyText);
  const expected = searchWorkspaceDocs([fresh], "refund policy", new Map())[0];
  assert.deepEqual(
    searchWorkspaceDocs(view.get().docs, "refund policy", new Map())[0]
      .passages,
    expected.passages,
    "passage locations and fingerprints agree with freshly extracted text",
  );

  await act(async () => view.get().reindex());
  await until(() => assert.equal(writes, 2));
  assert.equal(reads, 1, "refresh can reuse the corrected unchanged entry");
  assert.equal(view.get().docs[0].bodyText, fresh.bodyText);

  const reopened = await mount(t);
  await until(() => assert.equal(reopened.get().state.status, "ready"));
  assert.equal(reads, 1, "the replacement cache is reusable on next startup");
  assert.equal(reopened.get().docs[0].bodyText, fresh.bodyText);
});
test("word order, quotes, punctuation, block boundaries and filename-only results are explicit", () => {
  const doc = prepareCatalogDocument(
    meta("/folder/identity.md"),
    "# A\n\nOur refund\n**policy** covers don’t panic.\n\nSupport is here.\n\nPlans are there.\n\n`secret code`",
  );
  assert.equal(
    searchWorkspaceDocs([doc], "policy refund", new Map()).length,
    1,
  );
  assert.equal(
    searchWorkspaceDocs([doc], '"policy refund"', new Map()).length,
    0,
  );
  assert.equal(
    searchWorkspaceDocs([doc], '"refund policy"', new Map())[0].passages.length,
    1,
  );
  assert.equal(searchWorkspaceDocs([doc], "don't panic", new Map()).length, 1);
  assert.equal(
    searchWorkspaceDocs([doc], "support plans", new Map())[0].passages.length,
    0,
  );
  assert.equal(searchWorkspaceDocs([doc], '"here plans"', new Map()).length, 0);
  assert.equal(
    searchWorkspaceDocs([doc], "identity.md", new Map())[0].passage,
    undefined,
  );
  assert.equal(searchWorkspaceDocs([doc], "secret", new Map()).length, 0);
});
test("Find normalizes prose with correct Unicode and inline offsets while code stays literal", () => {
  const host = document.createElement("div");
  host.innerHTML =
    "<p>İ 😀 Don’t <strong>refund</strong>\n twice.</p><pre><code>don’t refund\n twice</code></pre>";
  document.body.append(host);
  const matches = highlightSearchMatches(host, "don't refund twice");
  assert.equal(matches.length, 1);
  assert.equal(
    matches[0].map((m) => m.textContent).join(""),
    "Don’t refund\n twice",
  );
  host.remove();
});
test("passage navigation selects the second identical paragraph and rejects a changed target", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = { current: null };
  let api;
  function Probe() {
    api = useSearch(ref);
    return React.createElement(
      "div",
      { ref },
      React.createElement("p", null, "Repeated passage."),
      React.createElement("p", null, "Repeated passage."),
    );
  }
  await act(async () => root.render(React.createElement(Probe)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const doc = prepareCatalogDocument(
    meta("/a.md"),
    "Repeated passage.\n\nRepeated passage.",
  );
  const hit = searchWorkspaceDocs([doc], "repeated", new Map())[0];
  assert.equal(hit.passageCount, 2);
  await act(async () => assert.equal(api.openPassage(hit.passages[1]), true));
  assert.ok(
    host.querySelectorAll("p")[1].querySelector("mark.search-highlight-active"),
  );
  await act(async () =>
    assert.equal(
      api.openPassage({ ...hit.passages[1], block: "Changed paragraph." }),
      false,
    ),
  );
  assert.equal(host.querySelectorAll("mark").length, 0);
});
test("late cache hydration and cancelled reads never publish the previous folder", async (t) => {
  const cache = deferred();
  let calls = 0,
    reads = 0;
  ipc({
    load_search_cache: () => (++calls === 1 ? cache.promise : null),
    list_workspace_markdown_files: ({ root }) =>
      listing([meta(`${root}/a.md`)]),
    read_markdown_file: () => {
      reads++;
      return "new";
    },
  });
  const view = await mount(t);
  await until(() => assert.equal(calls, 1));
  await view.render("/replacement");
  // The one cache read is shared by every run; a replaced folder waits for it.
  await act(async () =>
    cache.resolve(
      buildSearchCache([
        prepareCatalogDocument(meta("/folder/stale.md"), "stale"),
      ]),
    ),
  );
  await until(() => assert.equal(view.get().state.status, "ready"));
  await settle();
  assert.deepEqual(
    view.get().docs.map((d) => d.path),
    ["/replacement/a.md"],
  );
  assert.equal(reads, 1);
});
test("external additions, renames and deletions reconcile without a manual search refresh", async (t) => {
  let files = [meta("/folder/before.md")];
  ipc({ list_workspace_markdown_files: () => listing(files) });
  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"));
  files = [meta("/folder/renamed.md"), meta("/folder/added.md")];
  await act(async () => view.get().reconcile());
  await until(() => assert.equal(view.get().state.status, "ready"));
  await until(() =>
    assert.deepEqual(
      view.get().docs.map((d) => d.name),
      ["renamed.md", "added.md"],
    ),
  );
});

test("a recheck of the same folder keeps its subfolders and notices until the new listing arrives", async (t) => {
  const held = deferred();
  let hold = false;
  ipc({
    list_workspace_markdown_files: async () => {
      if (hold) await held.promise;
      return { ...listing([meta("/folder/a.md")]), directories: ["sub"], issues: ["sub/x: unreadable"], limitHit: true };
    },
  });
  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"));
  assert.deepEqual(view.get().state.directories, ["sub"]);
  hold = true;
  await act(async () => view.get().reconcile());
  await until(() => assert.equal(view.get().state.status, "indexing"));
  assert.deepEqual(view.get().state.directories, ["sub"]);
  assert.deepEqual(view.get().state.issues, ["sub/x: unreadable"]);
  assert.equal(view.get().state.limitHit, true);
  held.resolve();
  await until(() => assert.equal(view.get().state.status, "ready"));
  assert.deepEqual(view.get().state.directories, ["sub"]);
});

for (const fixture of [
  {
    name: "footnote.md",
    source: "Read this note[^1].\n\n[^1]: Refund policy applies.",
    query: "refund policy",
    passage: 0,
    expected: "Refund policy",
  },
  {
    name: "repeated-footnote.md",
    source:
      "Read this note[^1] and again[^1].\n\n[^1]: Refund policy applies. Refund policy applies.",
    query: "refund policy",
    passage: 1,
    expected: "Refund policy",
  },
  {
    name: "inline-code.md",
    source: "Before **Refund** policy `code` after Refund policy.",
    query: "refund policy",
    passage: 1,
    expected: "Refund policy",
  },
  {
    name: "line-break.md",
    source: "Refund  \n**policy** applies.",
    query: "refund policy",
    passage: 0,
    expected: "Refund\npolicy",
  },
  {
    name: "screenplay.fountain",
    source:
      "Title: Example\n\nINT. ROOM - DAY #2#\n\nSARAH\nRefund policy applies.\n\nJOHN\nRefund policy applies.",
    query: "refund policy",
    passage: 1,
    expected: "Refund policy",
  },
  {
    name: "prefix.md",
    source: "A long paragraph Refund policy " + "word ".repeat(6200),
    query: "refund policy",
    passage: 0,
    expected: "Refund policy",
  },
  {
    name: "inline-math.md",
    source: "Where $$x^2$$ is the value we need.",
    query: "value we need",
    passage: 0,
    expected: "value we need",
  },
  {
    // Rendered math reads as "x2"; the prose paragraph "x2" must be chosen.
    name: "formula-vs-prose.md",
    source: "Formula $$x^2$$ here.\n\nx2",
    query: '"x2"',
    passage: 0,
    expected: "x2",
    outsideMath: true,
  },
])
  test(`search passage resolves through the actual reader: ${fixture.name}`, async (t) => {
    const {
      ToastProvider,
    } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
    const {
      MarkdownRenderer,
    } = require("../.tmp/workspace-tests/src/components/MarkdownRenderer.js");
    const {
      FountainRenderer,
    } = require("../.tmp/workspace-tests/src/components/FountainRenderer.js");
    const {
      parseFountain,
    } = require("../.tmp/workspace-tests/src/lib/fountain.js");
    const {
      DEFAULT_READER_SETTINGS: settings,
    } = require("../.tmp/workspace-tests/src/lib/reader-settings.js");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const ref = { current: null };
    let api;
    function Probe() {
      api = useSearch(ref);
      return fixture.name.endsWith(".fountain")
        ? React.createElement(FountainRenderer, {
            parsed: parseFountain(fixture.source),
            settings,
            contentRef: ref,
          })
        : React.createElement(MarkdownRenderer, {
            content: fixture.source,
            filePath: "/" + fixture.name,
            settings,
            contentRef: ref,
            imagesAuthorized: false,
            onOpenFragment: () => false,
          });
    }
    await act(async () =>
      root.render(
        React.createElement(ToastProvider, null, React.createElement(Probe)),
      ),
    );
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const doc = prepareCatalogDocument(
      meta("/" + fixture.name),
      fixture.source,
    );
    const hit = searchWorkspaceDocs([doc], fixture.query, new Map())[0];
    assert.ok(hit.passages[fixture.passage]);
    await act(async () =>
      assert.equal(api.openPassage(hit.passages[fixture.passage]), true),
    );
    assert.equal(
      [...host.querySelectorAll("mark.search-highlight-active")]
        .map((mark) => mark.textContent)
        .join(""),
      fixture.expected,
    );
    if (fixture.passage)
      assert.ok(
        !host
          .querySelector("mark")
          .classList.contains("search-highlight-active"),
      );
    if (fixture.outsideMath)
      assert.ok(
        !host.querySelector("mark.search-highlight-active").closest(".katex"),
      );
  });
test("Find treats rendered math as literal code and never matches across it", async (t) => {
  const {
    ToastProvider,
  } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
  const {
    MarkdownRenderer,
  } = require("../.tmp/workspace-tests/src/components/MarkdownRenderer.js");
  const {
    DEFAULT_READER_SETTINGS: settings,
  } = require("../.tmp/workspace-tests/src/lib/reader-settings.js");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = { current: null };
  await act(async () =>
    root.render(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(MarkdownRenderer, {
          content: "Where $$x^2$$ is the value we need.",
          filePath: "/math.md",
          settings,
          contentRef: ref,
          imagesAuthorized: false,
          onOpenFragment: () => false,
        }),
      ),
    ),
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  assert.equal(highlightSearchMatches(ref.current, "x2 is the").length, 0);
  assert.equal(highlightSearchMatches(ref.current, "is the value").length, 1);
  const math = highlightSearchMatches(ref.current, "x2");
  assert.equal(math.length, 1);
  assert.ok(math[0][0].closest(".katex"));
});

test("exact phrases outrank earlier unordered passages and excerpts retain original case", () => {
  const doc = prepareCatalogDocument(
    meta("/a.md"),
    "Policy says Refund.\n\nRefund Policy applies.",
  );
  const hit = searchWorkspaceDocs([doc], "refund policy", new Map())[0];
  assert.equal(hit.passages[0].snippet, "Refund Policy applies.");
  assert.equal(hit.passages[0].findQuery, "refund policy");
  assert.equal(hit.passages[1].findQuery, undefined);
});
test("supported smart punctuation maps to whole original characters, and annotations remain exact", () => {
  const {
    phraseMatches,
  } = require("../.tmp/workspace-tests/src/lib/search-text.js");
  const {
    resolveAnchor,
  } = require("../.tmp/workspace-tests/src/lib/text-anchoring.js");
  assert.deepEqual(
    phraseMatches("😀 Wait… “Yes”—then–go", 'wait... "yes"---then--go'),
    [{ start: 3, end: 22 }],
  );
  assert.deepEqual(phraseMatches("—", "--"), []);
  const host = document.createElement("div");
  host.innerHTML = "<p>Don’t panic.</p>";
  assert.equal(
    resolveAnchor({ exact: "Don't panic.", prefix: "", suffix: "" }, host)
      .status,
    "missing",
  );
});

test("a disconnected configured folder retains last-known names with specific failure information", async (t) => {
  let offline = false;
  ipc({
    list_workspace_markdown_files: () => {
      if (offline)
        throw {
          category: "notFound",
          operation: "resolveWorkspace",
          message: "Folder disconnected: /folder",
          detail: "",
        };
      return listing([meta("/folder/a.md")]);
    },
  });
  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"));
  offline = true;
  await act(async () => view.get().reindex());
  await until(() => assert.equal(view.get().state.status, "error"));
  assert.equal(view.get().docs[0].coverage, "missing");
  assert.match(view.get().docs[0].problem, /Folder disconnected/);
  assert.equal(
    searchWorkspaceDocs(view.get().docs, "a.md", new Map()).length,
    1,
  );
});
test("a skipped drafts listing offers Show existing drafts, which lists with force", async (t) => {
  const forces = [];
  ipc({
    list_draft_documents: ({ force }) => {
      forces.push(force);
      return force
        ? listing([meta("/draft/old.md")])
        : { ...listing([]), skipped: true };
    },
    read_markdown_file: ({ path }) =>
      path.includes("old") ? "An old draft" : "# A\n\nOriginal passage",
  });
  const view = await mount(t, "/folder", [], true);
  await until(() => assert.equal(view.get().state.status, "ready"));
  assert.equal(view.get().state.draftsSkipped, true);
  await act(async () =>
    view.host.querySelector("#navigation-tab-Drafts").click(),
  );
  assert.match(view.host.textContent, /Drafts you create are saved in Documents › Bindars Drafts\./);
  assert.doesNotMatch(view.host.textContent, /No drafts yet|Looking for drafts/);
  const button = [...view.host.querySelectorAll("button")].find(
    (node) => node.textContent === "Show existing drafts",
  );
  assert.ok(button);
  await act(async () => button.click());
  await until(() =>
    assert.equal(
      view.get().docs.filter((doc) => doc.sources.includes("draft")).length,
      1,
    ),
  );
  assert.deepEqual(forces, [false, true]);
  assert.equal(view.get().state.draftsSkipped, false);
  assert.doesNotMatch(view.host.textContent, /Show existing drafts/);
  assert.match(view.host.textContent, /An old draft/);
});
test("newly saved drafts are immediately discoverable without another folder scan", async (t) => {
  let scans = 0;
  ipc({
    list_workspace_markdown_files: () => {
      scans++;
      return listing([]);
    },
  });
  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"));
  await act(async () =>
    view
      .get()
      .updateSaved(
        "/draft/new.md",
        "# Fresh draft",
        { size: 13, mtimeMs: 2 },
        true,
      ),
  );
  assert.equal(scans, 1);
  assert.ok(view.get().docs[0].sources.includes("draft"));
  assert.equal(view.get().docs[0].draftLabel, "Fresh draft");
});

for (const canonicalRoot of [undefined, "/private/tmp/project"]) {
  test(`saving keeps discovered folder-relative locations with an aliased root (${canonicalRoot ?? "metadata fallback"})`, async (t) => {
    const path = "/private/tmp/project/a.md";
    ipc({
      list_workspace_markdown_files: () => ({
        ...listing([meta(path)]),
        canonicalRoot,
      }),
    });
    const view = await mount(t, "/tmp/project", [], true);
    await until(() => assert.equal(view.get().state.status, "ready"));
    await act(async () =>
      view.host.querySelector("#navigation-tab-Folders").click(),
    );
    assert.match(
      view.host.querySelector(".document-open").textContent,
      /a\.md/,
    );
    await act(async () =>
      view
        .get()
        .updateSaved(path, "Saved footnote policy", { size: 21, mtimeMs: 2 }),
    );
    const doc = view.get().docs.find((doc) => doc.path === path);
    assert.equal(doc.relPath, "a.md");
    assert.ok(doc.sources.includes("folder"));
    assert.match(
      view.host.querySelector(".document-open").textContent,
      /a\.md/,
    );
    assert.equal(
      searchWorkspaceDocs(view.get().docs, "footnote", new Map()).length,
      1,
    );
  });
}

test("canonical folder identity admits new saves, rejects sibling folders and is discarded on replacement", async (t) => {
  ipc({
    list_workspace_markdown_files: ({ root }) => ({
      ...listing([]),
      canonicalRoot: `/private${root}`,
    }),
  });
  const view = await mount(t, "/tmp/project");
  await until(() => assert.equal(view.get().state.status, "ready"));
  await act(async () => {
    view.get().updateSaved("/private/tmp/project/Sub/New.md", "New text", {
      size: 8,
      mtimeMs: 2,
    });
    view.get().updateSaved("/private/tmp/project-other/Outside.md", "Outside", {
      size: 7,
      mtimeMs: 2,
    });
  });
  assert.equal(view.get().docs[0].relPath, "Sub/New.md");
  assert.ok(view.get().docs[0].sources.includes("folder"));
  assert.ok(!view.get().docs[1].sources.includes("folder"));
  await view.render("/tmp/replacement");
  await until(() => assert.equal(view.get().state.status, "ready"));
  await act(async () =>
    view.get().updateSaved("/private/tmp/project/Sub/New.md", "Old folder", {
      size: 10,
      mtimeMs: 3,
    }),
  );
  assert.ok(!view.get().docs[0].sources.includes("folder"));
});

test("folder-relative paths preserve case across Windows spellings and reject prefix collisions", () => {
  const {
    relativeDocumentPath,
    isRelativeDocumentPath,
  } = require("../.tmp/workspace-tests/src/lib/paths.js");
  assert.equal(
    relativeDocumentPath("C:\\Notes\\", "\\\\?\\C:\\notes\\Sub\\New.md"),
    "Sub/New.md",
  );
  assert.equal(relativeDocumentPath("/folder", "/folder-other/a.md"), null);
  assert.equal(relativeDocumentPath("/", "/a.md"), "a.md");
  assert.equal(relativeDocumentPath("/folder", "/folder/../outside.md"), null);
  for (const path of ["/absolute.md", "../outside.md", "C:\\absolute.md"])
    assert.equal(isRelativeDocumentPath(path), false);
});

for (const order of ["folder known before the first run", "folder path arrives after the first run published"])
  test(`cached folder documents are reused at startup: ${order}`, async (t) => {
    const cache = buildSearchCache([
      prepareCatalogDocument(meta("/folder/a.md"), "# A\n\nOriginal passage"),
      prepareCatalogDocument(meta("/drafts/d.md"), "# D\n\nDraft passage"),
    ]);
    const reads = [];
    ipc({
      load_search_cache: () => cache,
      list_draft_documents: () => listing([meta("/drafts/d.md")]),
      read_markdown_file: ({ path }) => {
        reads.push(path);
        return "# A\n\nOriginal passage";
      },
    });
    const view = await mount(t, order.startsWith("folder known") ? "/folder" : null);
    await until(() => assert.equal(view.get().state.status, "ready"));
    if (!order.startsWith("folder known")) await view.render("/folder");
    await until(() => assert.equal(view.get().state.rootPath, "/folder"));
    await until(() => assert.equal(view.get().state.status, "ready"));
    assert.equal(view.get().docs.find((d) => d.path === "/folder/a.md").coverage, "ready");
    assert.deepEqual(reads, [], "unchanged cached documents are not read again");
  });

test("Remove then Add Back reuses this session's parsed documents without re-reading", async (t) => {
  const saves = [];
  const reads = [];
  ipc({
    load_search_cache: () => saves.at(-1) ?? null,
    save_search_cache: ({ cache }) => {
      saves.push(structuredClone(cache));
    },
    read_markdown_file: ({ path }) => {
      reads.push(path);
      return "# A\n\nOriginal passage";
    },
  });
  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"));
  await until(() => assert.equal(saves.length, 1));
  await view.render(null);
  await until(() => assert.equal(saves.length, 2));
  assert.deepEqual(saves[1].docs, [], "the disk cache no longer holds the removed folder");
  await view.render("/folder");
  await until(() => assert.equal(saves.length, 3));
  assert.deepEqual(view.get().docs.map((d) => d.path), ["/folder/a.md"]);
  assert.equal(view.get().docs[0].coverage, "ready");
  assert.deepEqual(reads, ["/folder/a.md"], "Add Back restores the folder from retained entries");
});

test("retained text from earlier folders is bounded; evicted documents are read again on return", async (t) => {
  const { CACHE_MAX_CHARS } = require("../.tmp/workspace-tests/src/lib/search-cache.js");
  const { MAX_WORKSPACE_BODY_CHARS } = require("../.tmp/workspace-tests/src/lib/workspace-limits.js");
  const count = Math.ceil(CACHE_MAX_CHARS / MAX_WORKSPACE_BODY_CHARS) + 2;
  const body = "word ".repeat(MAX_WORKSPACE_BODY_CHARS / 5 + 10);
  const reads = [];
  ipc({
    list_workspace_markdown_files: ({ root }) =>
      listing(root === "/folder" ? Array.from({ length: count }, (_, i) => meta(`/folder/${i}.md`)) : [meta("/other/b.md")]),
    read_markdown_file: ({ path }) => {
      reads.push(path);
      return body;
    },
  });
  const view = await mount(t);
  await until(() => assert.equal(view.get().state.status, "ready"), 400);
  assert.equal(reads.length, count);
  await view.render("/other");
  await until(() => assert.equal(view.get().state.rootPath, "/other"));
  await until(() => assert.equal(view.get().state.status, "ready"));
  reads.length = 0;
  await view.render("/folder");
  await until(() => assert.equal(view.get().state.rootPath, "/folder"));
  await until(() => assert.equal(view.get().state.status, "ready"), 400);
  assert.ok(reads.length > 0, "entries beyond the retention budget were evicted");
  assert.ok(reads.length < count, "entries within the budget were reused");
  assert.equal(view.get().docs.filter((d) => d.coverage === "partial").length, count);
});

test("removed metadata-heavy folders obey retention bounds and reuse only surviving entries", async t => {
  const reads = [];
  ipc({
    list_workspace_markdown_files: ({ root }) => listing([meta(`${root}/a.md`)]),
    read_markdown_file: ({ path }) => {
      reads.push(path);
      return '---\ntitle: ' + 'metadata '.repeat(15000) + '\n---\n\nTiny body.';
    },
  });
  const view = await mount(t, '/folder-0');
  const ready = async root => until(() => {
    assert.equal(view.get().state.rootPath, root);
    assert.equal(view.get().state.status, 'ready');
  });
  await ready('/folder-0');
  for (let i = 1; i < 18; i++) { await view.render(`/folder-${i}`); await ready(`/folder-${i}`); }
  await view.render(null); await ready(null);
  assert.equal(view.get().docs.length, 0);
  assert.equal(reads.length, 18);
  await view.render('/folder-17'); await ready('/folder-17');
  assert.equal(reads.length, 18, 'recent retained entry is reused after removal');
  await view.render('/folder-0'); await ready('/folder-0');
  assert.equal(reads.length, 19, 'old metadata-heavy entry was evicted and must be read again');
});
