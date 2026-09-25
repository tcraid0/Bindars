const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const React = require("react");
const { act } = React;
const { clearMocks, mockIPC, mockWindows, mockConvertFileSrc } = require("@tauri-apps/api/mocks");
const { emit } = require("@tauri-apps/api/event");
const { installDom } = require("./_helpers/dom.cjs");
const { createNativeOpenIpc } = require("./_helpers/native-open.cjs");

// App-level coverage of the native image authorization boundary: the reader
// only requests document images (Markdown images and Mermaid, which mints its
// own image requests) once the native protocol has accepted the published
// document, unrelated workspace indexing reads never authorize anything, and
// printing waits for that readiness.

let flushSync;
let createRoot;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }
  throw lastError;
}

function dispatchShortcut(key) {
  flushSync(() => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
      key, ctrlKey: true, bubbles: true, cancelable: true,
    }));
  });
}

const DOCUMENTS = {
  "/tmp/a/A.md": "# A\n\n![Pic](pic.png)\n\n```mermaid\nflowchart TD\n  A-->B\n```\n",
  "/tmp/b/B.md": "# B\n\n![Other](other.png)\n",
  "/tmp/ws/indexed.md": "# Indexed elsewhere\n\n![Indexed](indexed.png)\n",
};

function loadApp() {
  const originalLoad = Module._load;
  Module._load = function loadWithFixtures(request, parent, isMain) {
    if (request.endsWith("welcome.md?raw")) return "# Welcome fixture";
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../.tmp/workspace-tests/src/App.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

async function renderImageApp(t, { workspaceFiles = [] } = {}) {
  await installDom();
  ({ flushSync } = require("react-dom"));
  ({ createRoot } = require("react-dom/client"));
  mockWindows("main");
  mockConvertFileSrc("macos");
  const originalMatchMedia = window.matchMedia;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (typeof globalThis.getComputedStyle !== "function") {
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  }
  window.matchMedia = (query) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });

  // Mermaid is replaced by a recorder: a real render would issue the image
  // requests this boundary exists to gate, so the moment it starts is the fact
  // under test.
  const mermaidRenders = [];
  const originalLoad = Module._load;
  Module._load = function loadWithMermaidRecorder(request, parent, isMain) {
    if (request === "mermaid") {
      return {
        __esModule: true,
        default: {
          initialize() {},
          async render(id, chart) {
            mermaidRenders.push(chart);
            return { svg: `<svg data-recorded-diagram="${id}"></svg>` };
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const preparation = require("../.tmp/workspace-tests/src/lib/print-export.js");
  const printPreparations = [];
  t.mock.method(preparation, "preparePrintDocument", ({ root }) => {
    const operation = deferred();
    printPreparations.push({ ...operation, root });
    return operation.promise;
  });

  const authorizations = [];
  const indexedReads = [];
  let deferAuthorization = false;
  const nativeOpen = createNativeOpenIpc();
  mockIPC(nativeOpen.wrap((cmd, args = {}) => {
    switch (cmd) {
      case "initialize_annotation_storage":
        return { settingsReady: true, settingsError: null };
      case "is_draft_document":
        return false;
      case "load_annotations":
      case "save_annotations":
      case "plugin:store|save":
      case "plugin:store|set":
      case "plugin:window|set_title":
      case "watch_file":
      case "unwatch_file":
        return null;
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "recent-files") return [{ version: 1, files: [] }, true];
        if (args.key === "workspace:root" && workspaceFiles.length) return ["/tmp/ws", true];
        return [null, false];
      case "list_workspace_markdown_files":
        return { files: workspaceFiles, skippedCount: 0, limitHit: false };
      case "read_markdown_file":
        // Workspace indexing reads unrelated documents natively; that read
        // must never reach the image authorization.
        indexedReads.push(args.path);
        return DOCUMENTS[args.path];
      case "open_markdown_file":
        return {
          canonicalPath: args.path,
          name: args.path.split("/").at(-1),
          content: DOCUMENTS[args.path],
          revision: { mtimeMs: 1, size: DOCUMENTS[args.path].length, contentHash: args.path },
        };
      case "authorize_document_images": {
        const authorization = deferred();
        authorizations.push({ path: args.path, ...authorization });
        return deferAuthorization ? authorization.promise : null;
      }
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  }), { shouldMockEvents: true });

  const App = loadApp();
  const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(React.createElement(ToastProvider, null, React.createElement(App)));
  });
  await waitFor(() => assert.ok(host.querySelector(".empty-state-content")));

  t.after(async () => {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    host.remove();
    window.matchMedia = originalMatchMedia;
    globalThis.IntersectionObserver = originalIntersectionObserver;
    Module._load = originalLoad;
    clearMocks();
  });

  return {
    host,
    authorizations,
    indexedReads,
    mermaidRenders,
    printPreparations,
    authorizedPaths: () => authorizations.map((authorization) => authorization.path),
    deferAuthorizations(value) { deferAuthorization = value; },
    async openNatively(path) {
      nativeOpen.setPendingPath(path);
      await act(async () => {
        await emit("bindars://native-open-available");
      });
      await waitFor(() => assert.ok(host.textContent.includes(path.split("/").at(-1))));
    },
    image(alt) {
      return host.querySelector(`.markdown-body img[alt="${alt}"]`);
    },
  };
}

function requestedTuple(image) {
  const url = new URL(image.getAttribute("src"));
  assert.equal(url.protocol, "document-image:");
  return JSON.parse(decodeURIComponent(url.pathname.slice(1)));
}

test("document images and Mermaid start only after the native protocol accepts the published document, and printing waits", async (t) => {
  const app = await renderImageApp(t);
  app.deferAuthorizations(true);

  await app.openNatively("/tmp/a/A.md");
  assert.deepEqual(app.authorizedPaths(), ["/tmp/a/A.md"]);
  const pendingImage = await waitFor(() => {
    const image = app.image("Pic");
    assert.ok(image);
    return image;
  });
  assert.equal(pendingImage.hasAttribute("src"), false, "no request before native acceptance");
  assert.deepEqual(app.mermaidRenders, [], "Mermaid must not start under stale authorization");
  assert.ok(app.host.querySelector(".mermaid-loading"));

  dispatchShortcut("p");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(app.printPreparations.length, 0, "print must not prepare a reader whose images are not yet requested");
  assert.ok(app.host.querySelector(".print-status") === null);

  await act(async () => { app.authorizations[0].resolve(null); });
  const image = await waitFor(() => {
    const candidate = app.image("Pic");
    assert.ok(candidate?.getAttribute("src"));
    return candidate;
  });
  assert.ok(image === pendingImage, "the same element gains its source; nothing was marked failed");
  assert.deepEqual(requestedTuple(image), ["/tmp/a/A.md", "/tmp/a/pic.png"]);
  await waitFor(() => assert.deepEqual(app.mermaidRenders, ["flowchart TD\n  A-->B"]));

  dispatchShortcut("p");
  await waitFor(() => assert.equal(app.printPreparations.length, 1));
  assert.match(app.host.querySelector(".print-status").textContent, /Preparing print/);
});

test("switching documents re-authorizes for the new path only and unrelated workspace indexing never authorizes", async (t) => {
  const app = await renderImageApp(t, {
    workspaceFiles: [{ path: "/tmp/ws/indexed.md", relPath: "indexed.md", name: "indexed.md" }],
  });

  await app.openNatively("/tmp/a/A.md");
  await waitFor(() => assert.deepEqual(requestedTuple(app.image("Pic")), ["/tmp/a/A.md", "/tmp/a/pic.png"]));
  await waitFor(() => assert.deepEqual(app.indexedReads, ["/tmp/ws/indexed.md"]));
  assert.deepEqual(app.authorizedPaths(), ["/tmp/a/A.md"], "indexing reads must not publish or authorize");

  app.deferAuthorizations(true);
  await app.openNatively("/tmp/b/B.md");
  assert.deepEqual(app.authorizedPaths(), ["/tmp/a/A.md", "/tmp/b/B.md"]);
  const pending = await waitFor(() => {
    const image = app.image("Other");
    assert.ok(image);
    return image;
  });
  assert.equal(pending.hasAttribute("src"), false, "B's images wait for B's acceptance, not A's");
  assert.equal(app.image("Pic"), null);

  await act(async () => { app.authorizations[1].resolve(null); });
  await waitFor(() => assert.deepEqual(requestedTuple(app.image("Other")), ["/tmp/b/B.md", "/tmp/b/other.png"]));
  assert.deepEqual(app.authorizedPaths(), ["/tmp/a/A.md", "/tmp/b/B.md"]);
});

test("a new draft clears the authorized folder", async (t) => {
  const app = await renderImageApp(t);
  await app.openNatively("/tmp/a/A.md");
  await waitFor(() => assert.ok(app.image("Pic")?.getAttribute("src")));

  dispatchShortcut("n");
  await waitFor(() => assert.ok(app.host.querySelector(".cm-editor")));
  await waitFor(() => assert.deepEqual(app.authorizedPaths(), ["/tmp/a/A.md", null]));
});
