const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");

const { MarkdownRenderer } = require("../.tmp/workspace-tests/src/components/MarkdownRenderer.js");
const { PresentationView } = require("../.tmp/workspace-tests/src/components/PresentationView.js");
const { ToastProvider } = require("../.tmp/workspace-tests/src/components/ToastProvider.js");

const readerSettings = {
  fontSize: 18,
  contentWidth: 72,
  lineHeight: 1.6,
  fontFamily: "newsreader",
  paragraphSpacing: "comfortable",
  sceneLensEnabled: true,
  reducedEffects: false,
  printLayout: "standard",
  printWithTheme: false,
};

async function render(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return {
    host,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }));
  });
}

async function installNavigationDom() {
  await installDom();
  globalThis.matchMedia = window.matchMedia.bind(window);
  mockIPC((command) => {
    if (command === "plugin:path|resolve_directory") {
      return "/tmp";
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });
}

test("MarkdownRenderer decodes heading and footnote fragments before navigation", async () => {
  await installNavigationDom();
  const openedFragments = [];
  const content = [
    "# Café",
    "",
    "[Go](#café)",
    "",
    "Reference[^1]",
    "",
    "[^1]: Note",
  ].join("\n");
  const rendered = await render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(MarkdownRenderer, {
        content,
        filePath: "/tmp/document.md",
        settings: readerSettings,
        contentRef: React.createRef(),
        onOpenFragment(fragmentId) {
          openedFragments.push(fragmentId);
          return true;
        },
      }),
    ),
  );

  try {
    const headingLink = rendered.host.querySelector('a[href="#caf%C3%A9"]');
    const footnoteLink = rendered.host.querySelector("a[data-footnote-ref]");
    const backLink = rendered.host.querySelector("a[data-footnote-backref]");
    assert.ok(headingLink);
    assert.ok(footnoteLink);
    assert.ok(backLink);

    await click(headingLink);
    await click(footnoteLink);
    await click(backLink);

    assert.deepEqual(openedFragments, [
      "café",
      "user-content-fn-1",
      "user-content-fnref-1",
    ]);
    assert.ok(!rendered.host.querySelector('[role="alert"]'));
  } finally {
    await rendered.cleanup();
    clearMocks();
  }
});

test("MarkdownRenderer reports a missing generic link target without calling it a heading", async () => {
  await installNavigationDom();
  const rendered = await render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(MarkdownRenderer, {
        content: "[Missing](#not-there)",
        filePath: "/tmp/document.md",
        settings: readerSettings,
        contentRef: React.createRef(),
        onOpenFragment() {
          return false;
        },
      }),
    ),
  );

  try {
    const link = rendered.host.querySelector('a[href="#not-there"]');
    assert.ok(link);
    await click(link);

    const alert = rendered.host.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent, /Link target "#not-there" not found/);
    assert.doesNotMatch(alert.textContent, /Heading/);
  } finally {
    await rendered.cleanup();
    clearMocks();
  }
});

test("PresentationView resolves fragments only inside the active slide", async () => {
  await installNavigationDom();
  const outsideTarget = document.createElement("h1");
  outsideTarget.id = "café";
  outsideTarget.textContent = "Hidden reader heading";
  document.body.appendChild(outsideTarget);

  let scrolledTarget = null;
  outsideTarget.scrollIntoView = () => {
    scrolledTarget = outsideTarget;
  };
  const rendered = await render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(PresentationView, {
        slides: [{
          index: 0,
          content: [
            "# Café",
            "",
            "[Go](#café)",
            "",
            "Reference[^1]",
            "",
            "[^1]: Note",
          ].join("\n"),
        }],
        currentSlide: 0,
        settings: readerSettings,
        filePath: "/tmp/document.md",
        onExit() {},
        onNext() {},
        onPrev() {},
      }),
    ),
  );

  try {
    const slideHeading = rendered.host.querySelector('h1[id="café"]');
    const footnote = rendered.host.querySelector('li[id="user-content-fn-1"]');
    const headingLink = rendered.host.querySelector('a[href="#caf%C3%A9"]');
    const footnoteLink = rendered.host.querySelector("a[data-footnote-ref]");
    assert.ok(slideHeading);
    assert.ok(footnote);
    assert.ok(headingLink);
    assert.ok(footnoteLink);
    slideHeading.scrollIntoView = () => {
      scrolledTarget = slideHeading;
    };
    footnote.scrollIntoView = () => {
      scrolledTarget = footnote;
    };

    await click(headingLink);
    assert.ok(scrolledTarget === slideHeading);
    await click(footnoteLink);
    assert.ok(scrolledTarget === footnote);
    assert.ok(!rendered.host.querySelector('[role="alert"]'));
  } finally {
    await rendered.cleanup();
    outsideTarget.remove();
    clearMocks();
  }
});
