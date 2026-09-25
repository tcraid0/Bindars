const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { clearMocks, mockIPC, mockConvertFileSrc } = require("@tauri-apps/api/mocks");
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
    async rerender(nextElement) {
      await act(async () => root.render(nextElement));
    },
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
  mockConvertFileSrc("macos");
  mockIPC((command) => {
    if (command === "plugin:path|resolve_directory") {
      return "/tmp";
    }
    throw new Error(`Unexpected IPC command: ${command}`);
  });
}

test("MarkdownRenderer preserves heading and footnote fragment spelling until navigation", async () => {
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
        imagesAuthorized: true,
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
      "caf%C3%A9",
      "user-content-fn-1",
      "user-content-fnref-1",
    ]);
    assert.ok(!rendered.host.querySelector('[role="alert"]'));
  } finally {
    await rendered.cleanup();
    clearMocks();
  }
});

test("Unicode and percent-labelled footnotes navigate to their own references and definitions", async () => {
  await installNavigationDom();
  const { findFragmentElement } = require("../.tmp/workspace-tests/src/lib/editor-position.js");
  const labels = ["café", "注释", "%61", "a", "x%20y", "bad%ZZ"];
  const content = labels.map((label) => `Note[^${label}]`).join(" ")
    + "\n\n" + labels.map((label) => `[^${label}]: ${label} body`).join("\n\n");
  const targets = [];
  const rendered = await render(React.createElement(ToastProvider, null,
    React.createElement(MarkdownRenderer, {
      content, filePath: "/tmp/document.md", imagesAuthorized: true,
      settings: readerSettings, contentRef: React.createRef(),
      onOpenFragment(fragment) {
        const target = findFragmentElement(rendered.host, fragment);
        targets.push(target?.id);
        return Boolean(target);
      },
    })));
  try {
    const links = [...rendered.host.querySelectorAll("a[data-footnote-ref], a[data-footnote-backref]")];
    assert.equal(links.length, labels.length * 2);
    for (const link of links) {
      await click(link);
      assert.equal(targets.at(-1), link.getAttribute("href").slice(1));
    }
    assert.ok(!rendered.host.querySelector('[role="alert"]'));
  } finally {
    await rendered.cleanup();
    clearMocks();
  }
});

test("allowed mixed-case link schemes reach the opener without changing the rest of the URL", async () => {
  await installNavigationDom();
  const opened = [];
  mockIPC((command, args) => {
    assert.equal(command, "plugin:opener|open_url");
    opened.push(args.url);
  });
  const urls = ["hTtPs://example.invalid/Path?Query=Value#Fragment", "HTTP://example.invalid/A", "MAILTO:Name@example.invalid?subject=Hello"];
  const unsafe = ["JAVASCRIPT:alert(1)", "DATA:text/html,hello", "FILE:///tmp/file.md", "java&#x73;cript:alert(1)"];
  const content = [...urls, ...unsafe].map((url, i) => `[link${i}](<${url}>)`).join("\n\n")
    + "\n\n[reference][ref]\n\n[ref]: HTTPS://example.invalid/Reference\n\n<HTTP://example.invalid/Auto>";
  const rendered = await render(React.createElement(ToastProvider, null,
    React.createElement(MarkdownRenderer, {
      content, filePath: "/tmp/document.md", imagesAuthorized: true,
      settings: readerSettings, contentRef: React.createRef(), onOpenFragment: () => false,
    })));
  try {
    for (const link of rendered.host.querySelectorAll("a")) await click(link);
    assert.deepEqual(opened, [
      "https://example.invalid/Path?Query=Value#Fragment", "http://example.invalid/A",
      "mailto:Name@example.invalid?subject=Hello", "https://example.invalid/Reference", "http://example.invalid/Auto",
    ]);
    for (let i = urls.length; i < urls.length + unsafe.length; i++) {
      const link = [...rendered.host.querySelectorAll("a")].find((a) => a.textContent === `link${i}`);
      assert.ok(link);
      assert.equal(link.getAttribute("href"), null);
    }
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
        imagesAuthorized: true,
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

test("MarkdownRenderer explains why an absolute Markdown link cannot open", async () => {
  await installNavigationDom();
  const rendered = await render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(MarkdownRenderer, {
        // A drive-letter path such as `C:/docs/other.md` never reaches the click
        // handler: the sanitizer drops the unknown `c:` scheme with its href.
        content: "[Absolute](/docs/other.md) and [Text](./notes.txt)",
        filePath: "/tmp/document.md",
        imagesAuthorized: true,
        settings: readerSettings,
        contentRef: React.createRef(),
        onOpenFragment: () => false,
        onNavigateToFile() {
          throw new Error("absolute links must not navigate");
        },
      }),
    ),
  );

  try {
    const expectations = [
      ['a[href="/docs/other.md"]', /absolute paths and URLs to local files are not supported/],
      ['a[href="./notes.txt"]', /Cannot open \.txt files/],
    ];
    for (const [selector, expected] of expectations) {
      const link = rendered.host.querySelector(selector);
      assert.ok(link, selector);
      await click(link);
      const alerts = [...rendered.host.querySelectorAll('[role="alert"]')];
      assert.match(alerts.at(-1).textContent, expected, selector);
      assert.doesNotMatch(alerts.at(-1).textContent, /only \.md, \.markdown, or \.fountain links are supported.*other\.md/);
    }
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
        imagesAuthorized: true,
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


const { highlightSearchMatches, clearSearchHighlights } = require("../.tmp/workspace-tests/src/hooks/useSearch.js");
const { findAnchor, wrapRange } = require("../.tmp/workspace-tests/src/lib/text-anchoring.js");

const markedContent = "# Title\n\n![Preview](preview.png)\n\n[Jump](#title) words `code` more words.\n\n[Next](next.md)\n\n```js\nconst words = 1;\n```\n\n| Text |\n| --- |\n| words |";

function readerElement(props) {
  return React.createElement(ToastProvider, null, React.createElement(MarkdownRenderer, {
    content: markedContent, filePath: "/tmp/document.md", imagesAuthorized: true, settings: readerSettings,
    contentRef: React.createRef(), onOpenFragment: () => true, ...props,
  }));
}

function paintReaderMarks(host) {
  const article = host.querySelector("article");
  const range = findAnchor({ prefix: "Jump", exact: " words ", suffix: "code" }, article);
  assert.ok(range);
  wrapRange(range, "annotation-highlight-yellow", "saved");
  assert.ok(highlightSearchMatches(article, "wo").length >= 3);
  return article;
}

test("marked Markdown keeps nodes through image loading and uses the latest navigation callback", async () => {
  await installNavigationDom();
  const navigated = [];
  const rendered = await render(readerElement({ onNavigateToFile: () => navigated.push("old") }));
  try {
    const article = paintReaderMarks(rendered.host);
    const nodes = [...article.querySelectorAll("a, code, table, img, mark")];
    const link = article.querySelector('a[href="next.md"]');
    link.focus();
    await act(async () => article.querySelector("img").dispatchEvent(new window.Event("load")));
    await rendered.rerender(readerElement({
      onNavigateToFile: (path) => navigated.push(path),
    }));
    assert.ok(nodes.every((node) => node.isConnected), "image loading and callbacks must preserve marked nodes");
    assert.ok(document.activeElement === link);
    await click(link);
    assert.deepEqual(navigated, ["/tmp/next.md"]);
    clearSearchHighlights(article);
    assert.equal(article.querySelectorAll('mark[data-highlight-id="saved"]').length, 1);
    assert.match(article.textContent, /Jump words code more words/);
  } finally {
    await rendered.cleanup();
    clearMocks();
  }
});

test("marked Markdown updates mixed inline source at the same path without corrupting text", async () => {
  await installNavigationDom();
  const rendered = await render(readerElement());
  try {
    paintReaderMarks(rendered.host);
    const content = markedContent.replace("[Jump](#title) words `code` more words.", "[Jump](#title) revised **words** and `code`.");
    await rendered.rerender(readerElement({ content }));
    assert.match(rendered.host.querySelector("article").textContent, /Jump revised words and code/);
    assert.ok(!rendered.host.querySelector("mark"));
  } finally {
    await rendered.cleanup();
    clearMocks();
  }
});


test("identical Markdown in another file resets image errors and marks", async () => {
  await installNavigationDom();
  const rendered = await render(readerElement());
  try {
    await act(async () => rendered.host.querySelector("img").dispatchEvent(new window.Event("error")));
    assert.match(rendered.host.textContent, /image not shown: unavailable/);
    paintReaderMarks(rendered.host);
    await rendered.rerender(readerElement({ filePath: "/tmp/other/document.md" }));
    const image = rendered.host.querySelector("img");
    assert.ok(image, "new file must get its own image loading state");
    assert.deepEqual(JSON.parse(decodeURIComponent(new URL(image.src).pathname.slice(1))), ["/tmp/other/document.md", "/tmp/other/preview.png"]);
    assert.ok(!rendered.host.querySelector("mark"));
    assert.match(rendered.host.textContent, /Jump words code more words/);
  } finally {
    await rendered.cleanup();
    clearMocks();
  }
});
