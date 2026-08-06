const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const fountainModulePath = require.resolve("../.tmp/workspace-tests/src/lib/fountain.js");
const processingModulePath = require.resolve("../.tmp/workspace-tests/src/lib/document-processing.js");
const workspaceModulePath = require.resolve("../.tmp/workspace-tests/src/lib/workspace-index.js");
const rendererModulePath = require.resolve("../.tmp/workspace-tests/src/components/FountainRenderer.js");

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

const content = [
  "INT. OFFICE - DAY",
  "",
  "RILEY",
  "One line.",
].join("\n");

function makeMeta() {
  return {
    path: "/workspace/script.fountain",
    relPath: "script.fountain",
    name: "script.fountain",
    mtimeMs: 0,
    size: content.length,
  };
}

test("one open Fountain revision is parsed once across reader consumers and rendering", () => {
  const fountain = require(fountainModulePath);
  const originalParse = fountain.parseFountain;
  let parseCount = 0;
  fountain.parseFountain = (...args) => {
    parseCount += 1;
    return originalParse(...args);
  };

  delete require.cache[processingModulePath];
  delete require.cache[rendererModulePath];

  try {
    const { prepareReaderDocument } = require(processingModulePath);
    const { FountainRenderer } = require(rendererModulePath);
    const prepared = prepareReaderDocument(content, "fountain");

    assert.equal(prepared.status, "ready");
    assert.equal(parseCount, 1);
    assert.equal(prepared.parsedFountain.scenes.length, 1);
    assert.equal(fountain.extractCharacters(prepared.parsedFountain).length, 1);
    assert.equal(fountain.computeScriptStats(prepared.parsedFountain).scenes.length, 1);

    renderToStaticMarkup(React.createElement(FountainRenderer, {
      parsed: prepared.parsedFountain,
      settings: readerSettings,
      contentRef: React.createRef(),
    }));

    assert.equal(parseCount, 1);
  } finally {
    fountain.parseFountain = originalParse;
    delete require.cache[processingModulePath];
    delete require.cache[rendererModulePath];
  }
});

test("workspace Fountain indexing reuses one parse for structure and searchable text", () => {
  const fountain = require(fountainModulePath);
  const originalParse = fountain.parseFountain;
  let parseCount = 0;
  fountain.parseFountain = (...args) => {
    parseCount += 1;
    return originalParse(...args);
  };

  delete require.cache[workspaceModulePath];

  try {
    const { buildWorkspaceDoc } = require(workspaceModulePath);
    const doc = buildWorkspaceDoc(makeMeta(), content);

    assert.equal(parseCount, 1);
    assert.match(doc.bodyText, /One line\./);
  } finally {
    fountain.parseFountain = originalParse;
    delete require.cache[workspaceModulePath];
  }
});
