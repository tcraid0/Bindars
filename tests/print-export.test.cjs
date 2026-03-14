const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPrintCleanupController,
  preparePrintDocument,
  waitForFonts,
  waitForImages,
  waitForMermaidDiagrams,
  PRINT_CLEANUP_TIMEOUT_MS,
} = require("../.tmp/workspace-tests/src/lib/print-export.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createImage() {
  const listeners = {
    load: new Set(),
    error: new Set(),
  };

  return {
    complete: false,
    addEventListener(type, listener) {
      listeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type].delete(listener);
    },
    dispatch(type) {
      this.complete = true;
      for (const listener of [...listeners[type]]) {
        listener();
      }
    },
    listenerCount(type) {
      return listeners[type].size;
    },
  };
}

test("createPrintCleanupController clears stuck print state after timeout", async () => {
  let cleanupCount = 0;
  const controller = createPrintCleanupController(() => {
    cleanupCount += 1;
  }, 10);

  controller.arm();
  await delay(25);

  assert.equal(cleanupCount, 1);
});

test("createPrintCleanupController disarm cancels pending cleanup", async () => {
  let cleanupCount = 0;
  const controller = createPrintCleanupController(() => {
    cleanupCount += 1;
  }, 10);

  controller.arm();
  controller.disarm();
  await delay(25);

  assert.equal(cleanupCount, 0);
});

test("waitForImages resolves when images load before timeout", async () => {
  const image = createImage();

  const waitPromise = waitForImages([image], { timeoutMs: 50 });
  setTimeout(() => image.dispatch("load"), 10);

  await waitPromise;

  assert.equal(image.complete, true);
  assert.equal(image.listenerCount("load"), 0);
  assert.equal(image.listenerCount("error"), 0);
});

test("waitForImages stops waiting after the timeout cap", async () => {
  const image = createImage();
  const startedAt = Date.now();

  await waitForImages([image], { timeoutMs: 20 });

  assert.ok(Date.now() - startedAt < 80, "image preflight should stay bounded");
  assert.equal(image.complete, false);
  assert.equal(image.listenerCount("load"), 0);
  assert.equal(image.listenerCount("error"), 0);
});

test("waitForFonts resolves when fonts.ready rejects", async () => {
  await assert.doesNotReject(() =>
    waitForFonts(
      {
        ready: Promise.reject(new Error("font load failed")),
      },
      { timeoutMs: 20 },
    ),
  );
});

test("waitForMermaidDiagrams waits for loading diagrams to produce SVG", async () => {
  const state = { loading: true, svg: false };
  const diagram = {
    matches(selector) {
      return selector === ".mermaid-loading" ? state.loading : false;
    },
    querySelector(selector) {
      return selector === "svg" && state.svg ? {} : null;
    },
  };
  const root = {
    querySelectorAll(selector) {
      if (selector === ".mermaid-diagram") {
        return [diagram];
      }
      return [];
    },
  };

  setTimeout(() => {
    state.loading = false;
    state.svg = true;
  }, 10);

  await waitForMermaidDiagrams(root, { timeoutMs: 60 });

  assert.equal(state.svg, true);
});

test("preparePrintDocument accepts a null root", async () => {
  await assert.doesNotReject(() =>
    preparePrintDocument({
      root: null,
      fonts: null,
      requestAnimationFrameFn: (callback) => {
        callback(0);
        return 0;
      },
    }),
  );
});

test("print cleanup timeout constant stays at 30 seconds", () => {
  assert.equal(PRINT_CLEANUP_TIMEOUT_MS, 30_000);
});
