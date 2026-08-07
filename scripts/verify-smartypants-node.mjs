#!/usr/bin/env node
/** Retain a pinned Node comparison for the exact current-limit Smartypants fixture. */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkSmartypants from "remark-smartypants";

import {
  createSmartypantsFixture,
  SMARTYPANTS_CURRENT_LIMIT_TARGET,
} from "./generate-document-performance-fixtures.mjs";
import {
  assertOutputOutsideRepository,
  numericSummary,
  sourceTreeIdentity,
} from "./verify-document-performance.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_SHAPE = "punctuation";

function parseArguments(argv) {
  const options = { output: null, trials: 5, warmups: 2 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--output") options.output = path.resolve(value());
    else if (argument === "--trials") options.trials = Number.parseInt(value(), 10);
    else if (argument === "--warmups") options.warmups = Number.parseInt(value(), 10);
    else if (argument === "--help") {
      console.log("Usage: node scripts/verify-smartypants-node.mjs [--trials COUNT] [--warmups COUNT] [--output PATH]");
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new Error("--trials must be a positive integer");
  }
  if (!Number.isInteger(options.warmups) || options.warmups < 0) {
    throw new Error("--warmups must be a non-negative integer");
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function measuredSmartypantsPlugin(transformDurations) {
  return () => {
    const transform = remarkSmartypants();
    return (tree) => {
      const startedAt = performance.now();
      transform(tree);
      transformDurations.push(performance.now() - startedAt);
    };
  };
}

function renderFixture(content, endMarker) {
  const transformDurations = [];
  const startedAt = performance.now();
  const html = renderToStaticMarkup(
    React.createElement(
      Markdown,
      {
        remarkPlugins: [
          remarkGfm,
          measuredSmartypantsPlugin(transformDurations),
          remarkMath,
          remarkFrontmatter,
        ],
      },
      content,
    ),
  );
  const totalRenderMs = performance.now() - startedAt;
  if (transformDurations.length !== 1) {
    throw new Error(`Expected one Smartypants execution, observed ${transformDurations.length}`);
  }
  if (!html.includes(endMarker) || !html.includes("“hello”")) {
    throw new Error("Rendered fixture is missing its end marker or transformed quotation");
  }
  return { totalRenderMs, transformMs: transformDurations[0] };
}

async function installedPackageVersion(packageName) {
  const packageJsonPath = path.join(
    PROJECT_ROOT,
    "node_modules",
    packageName,
    "package.json",
  );
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  );
  return packageJson.version;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  if (options.output) {
    await assertOutputOutsideRepository(options.output);
  }

  const fixture = createSmartypantsFixture(
    SMARTYPANTS_CURRENT_LIMIT_TARGET,
    FIXTURE_SHAPE,
  );
  const sourceIdentity = await sourceTreeIdentity();
  for (let index = 0; index < options.warmups; index += 1) {
    renderFixture(fixture.content, fixture.endMarker);
  }

  const trials = [];
  for (let trial = 1; trial <= options.trials; trial += 1) {
    trials.push({ trial, ...renderFixture(fixture.content, fixture.endMarker) });
  }

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: "Node comparison only; product thresholds require assembled-app WebKitGTK evidence",
    command: [process.execPath, ...process.argv.slice(1)],
    protocol: {
      warmups: options.warmups,
      trials: options.trials,
      pluginOrder: [
        "remark-gfm",
        "measured remark-smartypants",
        "remark-math",
        "remark-frontmatter",
      ],
    },
    fixture: {
      id: `smartypants-${FIXTURE_SHAPE}-${SMARTYPANTS_CURRENT_LIMIT_TARGET}`,
      shape: FIXTURE_SHAPE,
      assembledSmartypantsChars: SMARTYPANTS_CURRENT_LIMIT_TARGET,
      sourceCodeUnits: fixture.content.length,
      utf8Bytes: Buffer.byteLength(fixture.content, "utf8"),
      sha256: sha256(fixture.content),
      endMarker: fixture.endMarker,
    },
    identity: {
      source: sourceIdentity,
      runtime: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? null,
        cpuLogicalCount: os.cpus().length,
        memoryBytes: os.totalmem(),
        reactMarkdown: await installedPackageVersion("react-markdown"),
        remarkSmartypants: await installedPackageVersion("remark-smartypants"),
      },
    },
    trials,
    summary: {
      transformMs: numericSummary(trials.map((trial) => trial.transformMs)),
      totalRenderMs: numericSummary(trials.map((trial) => trial.totalRenderMs)),
    },
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, serialized, "utf8");
    console.log(JSON.stringify({ output: options.output, summary: result.summary }, null, 2));
  } else {
    console.log(serialized);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
