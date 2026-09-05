const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act, StrictMode } = React;
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitFor(assertion) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

// Deterministic startup environment for the theme hook: both localStorage
// theme keys are cleared (or seeded), the system theme is stubbed, and the
// Node-global localStorage points at the test window. Returns a restore fn.
function setupThemeEnvironment({ primary = null, legacy = null, systemDark = false } = {}) {
  const originalMatchMedia = window.matchMedia;
  const originalLocalStorage = globalThis.localStorage;
  window.matchMedia = (query) => ({
    matches: systemDark,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
  globalThis.localStorage = window.localStorage;
  window.localStorage.removeItem("bindars-theme");
  window.localStorage.removeItem("markdown-reader-theme");
  if (primary) window.localStorage.setItem("bindars-theme", primary);
  if (legacy) window.localStorage.setItem("markdown-reader-theme", legacy);
  return function restoreThemeEnvironment() {
    window.localStorage.removeItem("bindars-theme");
    window.localStorage.removeItem("markdown-reader-theme");
    globalThis.localStorage = originalLocalStorage;
    window.matchMedia = originalMatchMedia;
  };
}

function themeStoreWrites(writes) {
  return writes
    .filter((write) => write.key === "theme")
    .map((write) => ({ key: write.key, value: write.value }));
}

// Installs a store mock whose "theme" read is controlled by `themeRead`
// (a value or a deferred promise) and records every store write.
function mockThemeStore({ themeRead = [null, false], failThemeRead = false } = {}) {
  const storeWrites = [];
  mockIPC((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "theme") {
          if (failThemeRead) throw new Error("store get failed");
          return themeRead;
        }
        return [null, false];
      case "plugin:store|set":
        storeWrites.push(args);
        return null;
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  });
  return { storeWrites };
}

function mockStrictModeThemeStore() {
  const reads = [deferred(), deferred()];
  const storeWrites = [];
  let themeReadCount = 0;
  mockIPC((cmd, args = {}) => {
    switch (cmd) {
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        if (args.key === "theme") {
          const read = reads[themeReadCount];
          themeReadCount += 1;
          assert.ok(read, "expected at most two StrictMode theme reads");
          return read.promise;
        }
        return [null, false];
      case "plugin:store|set":
        storeWrites.push(args);
        return null;
      default:
        throw new Error(`Unexpected IPC command: ${cmd}`);
    }
  });
  return {
    firstRead: reads[0],
    secondRead: reads[1],
    storeWrites,
    themeReadCount: () => themeReadCount,
  };
}

async function renderThemeProbe({ strict = false } = {}) {
  const { useTheme } = require("../.tmp/workspace-tests/src/hooks/useTheme.js");
  let latest = null;
  function Probe() {
    latest = useTheme();
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const element = React.createElement(Probe);
  await act(async () => {
    root.render(strict ? React.createElement(StrictMode, null, element) : element);
  });
  return {
    latest: () => latest,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("stored theme applies after startup when no user action occurs", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    assert.equal(rendered.latest().theme, "light");
    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    // Startup must not persist the temporary default before hydration settles.
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    await act(async () => {
      storedTheme.resolve(["sepia", true]);
    });
    await waitFor(() => assert.equal(rendered.latest().theme, "sepia"));
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    assert.equal(window.localStorage.getItem("bindars-theme"), "sepia");
    await waitFor(() => {
      assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "sepia" }]);
    });
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("a user cycle before the stored load resolves keeps the user theme", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    await act(async () => {
      rendered.latest().cycleTheme();
    });
    assert.equal(rendered.latest().theme, "sepia");
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    // The user choice persists immediately.
    await waitFor(() => {
      assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "sepia" }]);
    });

    await act(async () => {
      storedTheme.resolve(["dark", true]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "sepia");
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "sepia" }]);
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("multiple user changes before resolution keep the latest theme", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    await act(async () => {
      rendered.latest().cycleTheme();
    });
    await act(async () => {
      rendered.latest().cycleTheme();
    });
    await act(async () => {
      rendered.latest().setTheme("deep-dark");
    });
    assert.equal(rendered.latest().theme, "deep-dark");
    await waitFor(() => {
      assert.deepEqual(
        themeStoreWrites(storeWrites).map((write) => write.value),
        ["sepia", "dark", "deep-dark"],
      );
    });

    await act(async () => {
      storedTheme.resolve(["sepia", true]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "deep-dark");
    assert.equal(document.documentElement.getAttribute("data-theme"), "deep-dark");
    assert.deepEqual(
      themeStoreWrites(storeWrites).map((write) => write.value),
      ["sepia", "dark", "deep-dark"],
    );
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("explicitly selecting the already-visible theme before resolution wins over the stored value", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    assert.equal(rendered.latest().theme, "light");
    await act(async () => {
      rendered.latest().setTheme("light");
    });
    assert.equal(rendered.latest().theme, "light");
    await waitFor(() => {
      assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "light" }]);
    });

    await act(async () => {
      storedTheme.resolve(["dark", true]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "light");
    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "light" }]);
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("a direct setTheme before resolution keeps the user theme", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    await act(async () => {
      rendered.latest().setTheme("dark");
    });
    assert.equal(rendered.latest().theme, "dark");
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");

    await act(async () => {
      storedTheme.resolve(["sepia", true]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "dark");
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "dark" }]);
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("a legacy localStorage theme seeds startup and the stored value overrides it", async () => {
  await installDom();
  const restore = setupThemeEnvironment({ legacy: "dark" });
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    assert.equal(rendered.latest().theme, "dark");
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    await act(async () => {
      storedTheme.resolve(["sepia", true]);
    });
    await waitFor(() => assert.equal(rendered.latest().theme, "sepia"));
    assert.equal(document.documentElement.getAttribute("data-theme"), "sepia");
    await waitFor(() => {
      assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "sepia" }]);
    });
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("a primary localStorage theme is kept when the store has no value", async () => {
  await installDom();
  const restore = setupThemeEnvironment({ primary: "deep-dark" });
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    assert.equal(rendered.latest().theme, "deep-dark");
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    await act(async () => {
      storedTheme.resolve([null, false]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "deep-dark");
    assert.equal(document.documentElement.getAttribute("data-theme"), "deep-dark");
    // Hydration settled with no stored value: the fallback persists afterwards.
    assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "deep-dark" }]);
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("the system-dark fallback is not persisted until the stored read settles", async () => {
  await installDom();
  const restore = setupThemeEnvironment({ systemDark: true });
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    assert.equal(rendered.latest().theme, "dark");
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.equal(window.localStorage.getItem("bindars-theme"), "dark");
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    await act(async () => {
      storedTheme.resolve([null, false]);
    });
    await waitFor(() => {
      assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "dark" }]);
    });
    assert.equal(rendered.latest().theme, "dark");
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("an invalid stored value preserves the current fallback", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    await act(async () => {
      storedTheme.resolve(["neon", true]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "light");
    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "light" }]);
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("a failed stored read preserves the fallback and still settles hydration", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const { storeWrites } = mockThemeStore({ failThemeRead: true });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  const rendered = await renderThemeProbe();

  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "light");
    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][1]), /store get failed/);
    assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "light" }]);
  } finally {
    console.warn = originalWarn;
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("StrictMode ignores the stale read when the active read resolves first", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const { firstRead, secondRead, storeWrites, themeReadCount } = mockStrictModeThemeStore();
  const rendered = await renderThemeProbe({ strict: true });

  try {
    await waitFor(() => assert.equal(themeReadCount(), 2));
    assert.equal(rendered.latest().theme, "light");
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    // Resolve the second (active) load first, then the stale first load.
    await act(async () => {
      secondRead.resolve(["dark", true]);
    });
    await waitFor(() => assert.equal(rendered.latest().theme, "dark"));
    await act(async () => {
      firstRead.resolve(["sepia", true]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(rendered.latest().theme, "dark");
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "dark" }]);
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("StrictMode stale read cannot enable persistence before the active read settles", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const { firstRead, secondRead, storeWrites, themeReadCount } = mockStrictModeThemeStore();
  const rendered = await renderThemeProbe({ strict: true });

  try {
    await waitFor(() => assert.equal(themeReadCount(), 2));
    assert.equal(rendered.latest().theme, "light");
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    // The first effect has already been cleaned up, so its result must not
    // apply a theme or unlock persistence while the active read is pending.
    await act(async () => {
      firstRead.resolve(["sepia", true]);
      await firstRead.promise;
      await Promise.resolve();
    });
    assert.equal(rendered.latest().theme, "light");
    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    await act(async () => {
      secondRead.resolve(["dark", true]);
    });
    await waitFor(() => assert.equal(rendered.latest().theme, "dark"));
    assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
    await waitFor(() => {
      assert.deepEqual(themeStoreWrites(storeWrites), [{ key: "theme", value: "dark" }]);
    });
  } finally {
    await rendered.unmount();
    restore();
    clearMocks();
  }
});

test("a stored value resolving after unmount changes nothing and persists nothing", async () => {
  await installDom();
  const restore = setupThemeEnvironment();
  const storedTheme = deferred();
  const { storeWrites } = mockThemeStore({ themeRead: storedTheme.promise });
  const rendered = await renderThemeProbe();

  try {
    assert.equal(rendered.latest().theme, "light");
    assert.deepEqual(themeStoreWrites(storeWrites), []);

    await rendered.unmount();
    await act(async () => {
      storedTheme.resolve(["dark", true]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.documentElement.getAttribute("data-theme"), "");
    assert.deepEqual(themeStoreWrites(storeWrites), []);
  } finally {
    restore();
    clearMocks();
  }
});
