#!/usr/bin/env node
/**
 * Run parser stress cases through the browser build of the app's pipelines in
 * JavaScriptCore, the engine behind WKWebView and WebKitGTK. The workspace
 * tests use Node's V8, which can miss costs specific to JavaScriptCore:
 *
 * - It retries a leading variable-length lookbehind at every index, so a regex
 *   that is linear in V8 can be quadratic in the app (the Fountain cases).
 * - Shrinking a large array with `length =` costs time proportional to the
 *   array, which made micromark quadratic inside one huge Markdown paragraph
 *   and in big GFM tables until the micromark patches in patches/ (the
 *   Markdown cases, which the reader shares with the workspace index).
 *
 * Usage: node scripts/verify-jsc.mjs [path/to/jsc]
 * Without a path it uses $JSC, the macOS system shell, or `jsc` on PATH.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { build } from "vite";
import { sourceVolumeFixture } from "./generate-document-performance-fixtures.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MACOS_JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc";
// Generous: every case finishes in well under a second; some regressions take minutes.
const CASE_TIMEOUT_MS = 8_000;
// The Markdown cases take about 0.2 s with the patch on an M-series Mac and
// 5.6 s (long paragraph) or minutes (word soup) without it.
const MARKDOWN_BUDGET_MS = 2_000;
// The table takes about 0.2 s patched, 1.4 s without the edit-map patch, and
// 5 s on micromark-extension-gfm-table 2.1.1, so its budget is tighter.
const TABLE_BUDGET_MS = 1_000;
// The browser build of decode-named-character-reference creates an element on
// load and decodes through innerHTML; no case contains a character reference.
// compatMode keeps KaTeX's load-time quirks-mode warning quiet.
const DOCUMENT_SHIM = `globalThis.document = { compatMode: "CSS1Compat", createElement: () => ({ set innerHTML(value) { throw new Error("no DOM to decode " + value); } }) };\n`;

const require = createRequire(import.meta.url);
const { hostileCases, retainedText } = require("../tests/_helpers/fountain-hostile-cases.cjs");

// Just under the 1,048,576-unit source ceiling, as one paragraph of prose.
const longParagraphTitle = "Long paragraph";
const longParagraph = `# ${longParagraphTitle}\n\n${"Ordinary paragraph words for a larger document. ".repeat(21_400)}`
  .slice(0, 1_048_000);
// The document-performance protocol's accepted word-soup shape.
const wordSoupUnits = 524_288;
// Just under the structural ceiling, which rejects about 6,000 such rows.
const tableTitle = "Large table";
const largeTable = `# ${tableTitle}\n\n| a | b | c |\n|---|---|---|\n${
  Array.from({ length: 5_900 }, (_, row) => `| r${row} | cell text | more |\n`).join("")}`;

const cases = [
  ...Object.entries(hostileCases).map(([name, source]) => ({
    name,
    call: `checkFountain(${JSON.stringify(source)}, ${JSON.stringify(retainedText[name])})`,
  })),
  {
    name: "markdown-long-paragraph",
    call: `checkMarkdown(${JSON.stringify(longParagraph)}, ${JSON.stringify(longParagraphTitle)})`,
    budgetMs: MARKDOWN_BUDGET_MS,
  },
  {
    name: "markdown-word-soup",
    call: `checkMarkdown(${JSON.stringify(sourceVolumeFixture(wordSoupUnits, "word-soup").content)}, ${JSON.stringify(`Markdown source word-soup ${wordSoupUnits}`)})`,
    budgetMs: MARKDOWN_BUDGET_MS,
  },
  {
    name: "markdown-large-table",
    call: `checkMarkdown(${JSON.stringify(largeTable)}, ${JSON.stringify(tableTitle)})`,
    budgetMs: TABLE_BUDGET_MS,
  },
];

const jsc = process.argv[2] ?? process.env.JSC ?? (existsSync(MACOS_JSC) ? MACOS_JSC : "jsc");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "bindars-jsc-"));

try {
  const entry = path.join(tempDir, "entry.js");
  await writeFile(entry, `
import { prepareReaderDocument } from ${JSON.stringify(path.join(PROJECT_ROOT, "src/lib/document-processing.ts"))};
import { computeScriptStats, fountainToSearchableText, splitFountainInline } from ${JSON.stringify(path.join(PROJECT_ROOT, "src/lib/fountain.ts"))};
import { tryBuildWorkspaceDoc } from ${JSON.stringify(path.join(PROJECT_ROOT, "src/lib/workspace-index.ts"))};

globalThis.checkFountain = (source, retained) => {
  const started = Date.now();
  const prepared = prepareReaderDocument(source, "fountain");
  if (prepared.status !== "ready") throw new Error("status " + prepared.status);
  const parsed = prepared.parsedFountain;
  computeScriptStats(parsed);
  for (const token of parsed.tokens) if (token.text) splitFountainInline(token.text);
  const search = fountainToSearchableText(parsed);
  const text = [...parsed.titlePage.map((entry) => entry.value), ...parsed.tokens.map((token) => token.text ?? "")].join("\\n");
  if (!search || !text.includes(retained)) throw new Error("content was lost");
  return Date.now() - started;
};

globalThis.checkMarkdown = (source, title) => {
  const started = Date.now();
  const result = tryBuildWorkspaceDoc({ path: "/check.md", relPath: "check.md", name: "check.md" }, source);
  if (result.status !== "indexed") throw new Error("status " + result.status);
  const { doc } = result;
  if (doc.title !== title || doc.headings.length !== 1 || !doc.bodyText) throw new Error("content was lost");
  return Date.now() - started;
};
`);

  // Vite resolves fountain-js to its ESM build, micromark to its production
  // lib/ copy, and decode-named-character-reference to its browser build, as
  // the app bundle does.
  const result = await build({
    configFile: false,
    logLevel: "error",
    root: tempDir,
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["iife"], name: "BindarsJscCheck", fileName: "check" },
    },
  });
  const bundle = (Array.isArray(result) ? result[0] : result).output[0].code;

  let failures = 0;
  for (const { name, call, budgetMs } of cases) {
    const file = path.join(tempDir, `${name}.js`);
    await writeFile(file, `${DOCUMENT_SHIM}${bundle}\nprint(${call});\n`);
    const run = spawnSync(jsc, [file], { encoding: "utf8", timeout: CASE_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (run.error?.code === "ENOENT") {
      throw new Error(`JavaScriptCore shell not found at "${jsc}"; pass its path as the first argument or set JSC.`);
    }
    const elapsed = run.stdout.trim();
    const overBudget = budgetMs !== undefined && !(Number(elapsed) <= budgetMs);
    const passed = !run.error && run.status === 0 && !overBudget;
    if (!passed) failures += 1;
    const detail = run.error
      ? `exceeded ${CASE_TIMEOUT_MS} ms`
      : overBudget ? `${elapsed} ms exceeds ${budgetMs} ms` : (run.stderr || run.stdout).trim().split("\n")[0];
    console.log(`${passed ? "ok  " : "FAIL"} ${name}: ${passed ? `${elapsed} ms` : detail}`);
  }

  if (failures > 0) {
    console.error(`${failures} of ${cases.length} parser cases failed in JavaScriptCore.`);
    process.exitCode = 1;
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
