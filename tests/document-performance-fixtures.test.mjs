import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  generateDocumentPerformanceFixtures,
  MARKDOWN_SOURCE_AT_LIMIT_CODE_UNITS,
  MARKDOWN_SOURCE_REFUSAL_CODE_UNITS,
  MARKDOWN_SOURCE_SHAPES,
  MARKDOWN_SOURCE_SWEEP_CODE_UNITS,
  SMARTYPANTS_CURRENT_LIMIT_TARGET,
  SMARTYPANTS_DEGRADED_TARGET,
  SMARTYPANTS_SHAPES,
  SMARTYPANTS_TARGETS,
} from "../scripts/generate-document-performance-fixtures.mjs";

const require = createRequire(import.meta.url);
const {
  measureSmartypantsInput,
} = require("../.tmp/workspace-tests/src/lib/markdown-plugins.js");
const {
  checkDocumentComplexity,
} = require("../.tmp/workspace-tests/src/lib/document-complexity.js");

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function measureParsedSmartypantsInput(content) {
  let measurement = null;
  const captureMeasurement = () => (tree) => {
    measurement = measureSmartypantsInput(tree);
  };

  renderToStaticMarkup(
    React.createElement(
      Markdown,
      { remarkPlugins: [remarkGfm, captureMeasurement, remarkMath, remarkFrontmatter] },
      content,
    ),
  );
  return measurement;
}

test("generated performance fixtures pin source and parsed smartypants dimensions", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "bindars-performance-fixtures-test-"));
  try {
    const manifest = await generateDocumentPerformanceFixtures(outputDirectory);
    assert.equal(manifest.schemaVersion, 2);
    const smartypantsCases = manifest.cases.filter((entry) => entry.kind === "smartypants");
    assert.deepEqual(
      smartypantsCases.map((entry) => entry.assembledSmartypantsChars),
      [
        ...SMARTYPANTS_TARGETS.flatMap((target) => SMARTYPANTS_SHAPES.map(() => target)),
        SMARTYPANTS_CURRENT_LIMIT_TARGET,
        SMARTYPANTS_DEGRADED_TARGET,
      ],
    );
    for (const target of SMARTYPANTS_TARGETS) {
      for (const shape of SMARTYPANTS_SHAPES) {
        assert.ok(
          smartypantsCases.some(
            (entry) => entry.assembledSmartypantsChars === target && entry.shape === shape,
          ),
          `${shape} ${target}`,
        );
      }
    }

    for (const fixture of manifest.cases) {
      const content = await readFile(path.join(outputDirectory, fixture.fileName), "utf8");
      assert.equal(content.length, fixture.sourceCodeUnits, fixture.id);
      assert.equal(Buffer.byteLength(content, "utf8"), fixture.utf8Bytes, fixture.id);
      assert.equal(sha256(content), fixture.sha256, fixture.id);
      if (fixture.kind === "smartypants") {
        assert.equal(
          measureParsedSmartypantsInput(content).chars,
          fixture.assembledSmartypantsChars,
          fixture.id,
        );
        assert.ok(content.includes(fixture.endMarker), fixture.id);
      }
    }

    const acceptedSourceCases = manifest.cases.filter(
      (entry) => entry.kind === "source-volume" && entry.expected === "accepted",
    );
    assert.equal(
      acceptedSourceCases.length,
      MARKDOWN_SOURCE_SWEEP_CODE_UNITS.length * MARKDOWN_SOURCE_SHAPES.length,
    );
    for (const sourceCodeUnits of MARKDOWN_SOURCE_SWEEP_CODE_UNITS) {
      for (const shape of MARKDOWN_SOURCE_SHAPES) {
        const fixture = acceptedSourceCases.find(
          (entry) => entry.sourceCodeUnits === sourceCodeUnits && entry.shape === shape,
        );
        assert.ok(fixture, `${shape} ${sourceCodeUnits}`);
        const content = await readFile(path.join(outputDirectory, fixture.fileName), "utf8");
        assert.ok(content.includes(fixture.endMarker), fixture.id);
        assert.equal(checkDocumentComplexity(content, "markdown").ok, true, fixture.id);
      }
    }
    assert.ok(MARKDOWN_SOURCE_SWEEP_CODE_UNITS.includes(MARKDOWN_SOURCE_AT_LIMIT_CODE_UNITS));
    assert.equal(MARKDOWN_SOURCE_AT_LIMIT_CODE_UNITS, 1_048_576);

    const refused = manifest.cases.find((entry) => entry.expected === "refused");
    assert.ok(refused);
    assert.equal(refused.sourceCodeUnits, MARKDOWN_SOURCE_REFUSAL_CODE_UNITS);
    assert.equal(refused.sourceCodeUnits, 1_048_577);
    const refusedContent = await readFile(path.join(outputDirectory, refused.fileName), "utf8");
    const refusedResult = checkDocumentComplexity(refusedContent, "markdown");
    assert.equal(refusedResult.ok, false);
    assert.equal(refusedResult.error.violation.kind, "source-volume");

    const control = await readFile(path.join(outputDirectory, manifest.control.fileName), "utf8");
    assert.ok(control.includes(manifest.control.endMarker));
    for (const fixture of smartypantsCases) {
      assert.ok(control.includes(`./${fixture.fileName}`), fixture.id);
    }

    const coldControl = await readFile(
      path.join(outputDirectory, manifest.coldControl.fileName),
      "utf8",
    );
    assert.equal(coldControl.length, manifest.coldControl.sourceCodeUnits);
    assert.equal(Buffer.byteLength(coldControl, "utf8"), manifest.coldControl.utf8Bytes);
    assert.equal(sha256(coldControl), manifest.coldControl.sha256);
    assert.ok(coldControl.includes(manifest.coldControl.endMarker));
    assert.equal(checkDocumentComplexity(coldControl, "markdown").ok, true);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
