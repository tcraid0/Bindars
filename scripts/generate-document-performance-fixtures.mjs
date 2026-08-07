#!/usr/bin/env node
/** Generate compact, deterministic Markdown performance fixtures on demand. */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const SMARTYPANTS_TARGETS = [8_000, 9_000, 10_000, 11_000, 12_000];
export const SMARTYPANTS_SHAPES = [
  "punctuation",
  "quoted-prose",
  "formatting-split",
  "inline-code",
];
export const SMARTYPANTS_CURRENT_LIMIT_TARGET = 65_536;
export const SMARTYPANTS_DEGRADED_TARGET = SMARTYPANTS_CURRENT_LIMIT_TARGET + 1;
export const MARKDOWN_SOURCE_AT_LIMIT_CODE_UNITS = 1_048_576;
export const MARKDOWN_SOURCE_SWEEP_CODE_UNITS = [
  524_288,
  786_432,
  MARKDOWN_SOURCE_AT_LIMIT_CODE_UNITS,
];
export const MARKDOWN_SOURCE_SHAPES = [
  "word-soup",
  "ordinary-paragraphs",
  "fenced-code",
];
export const MARKDOWN_SOURCE_REFUSAL_CODE_UNITS =
  MARKDOWN_SOURCE_AT_LIMIT_CODE_UNITS + 1;

function punctuationFiller(codeUnits) {
  return "a,".repeat(Math.ceil(codeUnits / 2)).slice(0, codeUnits);
}

function whitespaceFiller(codeUnits) {
  return "a ".repeat(Math.ceil(codeUnits / 2)).slice(0, codeUnits);
}

function repeatedFiller(pattern, codeUnits) {
  return pattern.repeat(Math.ceil(codeUnits / pattern.length)).slice(0, codeUnits);
}

function formattingSplitFiller(codeUnits) {
  const wrappers = [
    ["*", "*"],
    ["**", "**"],
    ["[", "](https://example.invalid)"],
  ];
  const parts = [];
  let remaining = codeUnits;
  let wrapperIndex = 0;
  while (remaining >= 6) {
    const [open, close] = wrappers[wrapperIndex % wrappers.length];
    parts.push(`${open}alpha${close} `);
    remaining -= 6;
    wrapperIndex += 1;
  }
  if (remaining > 0) parts.push(punctuationFiller(remaining));
  return parts.join("");
}

function inlineCodeFiller(codeUnits) {
  const parts = [];
  let remaining = codeUnits;
  while (remaining >= 6) {
    parts.push("`alpha` ");
    remaining -= 6;
  }
  if (remaining > 0) parts.push(punctuationFiller(remaining));
  return parts.join("");
}

function smartypantsFiller(shape, codeUnits) {
  if (shape === "punctuation") return punctuationFiller(codeUnits);
  if (shape === "quoted-prose") {
    return repeatedFiller('She said "hello," and he replied "yes." ', codeUnits);
  }
  if (shape === "formatting-split") return formattingSplitFiller(codeUnits);
  if (shape === "inline-code") return inlineCodeFiller(codeUnits);
  throw new Error(`Unknown smartypants shape: ${shape}`);
}

export function createSmartypantsFixture(assembledChars, shape) {
  const heading = `Smartypants ${shape} ${assembledChars}`;
  const endMarker = `END_SMARTYPANTS_${shape.replaceAll("-", "_").toUpperCase()}_${assembledChars}`;
  const suffix = ` "hello" ${endMarker}`;
  const paragraphChars = assembledChars - heading.length - 1;
  const fillerChars = paragraphChars - suffix.length;
  if (fillerChars < 0) throw new Error(`Smartypants target ${assembledChars} is too small`);

  return {
    content: `# ${heading}\n\n${smartypantsFiller(shape, fillerChars)}${suffix}`,
    endMarker,
  };
}

function createTinyColdControlFixture() {
  const endMarker = "END_TINY_COLD_CONTROL";
  return {
    content: `# Tiny cold control\n\nA small Markdown document.\n\n${endMarker}\n`,
    endMarker,
  };
}

function sourceVolumeFixture(sourceCodeUnits, shape) {
  const sourceMarker = `END_SOURCE_${shape.replaceAll("-", "_").toUpperCase()}_${sourceCodeUnits}`;
  const heading = `Markdown source ${shape} ${sourceCodeUnits}`;
  const prefix = `# ${heading}\n\n`;
  const suffix = shape === "fenced-code"
    ? `\n\`\`\`\n\n${sourceMarker}`
    : `\n\n${sourceMarker}`;
  const bodyPrefix = shape === "fenced-code" ? "```text\n" : "";
  const fillerChars = sourceCodeUnits - prefix.length - bodyPrefix.length - suffix.length;
  if (fillerChars < 0) throw new Error(`Source target ${sourceCodeUnits} is too small`);

  let filler;
  if (shape === "word-soup") {
    filler = whitespaceFiller(fillerChars);
  } else if (shape === "ordinary-paragraphs") {
    filler = repeatedFiller(
      'Ordinary prose explains a local project in complete sentences, with enough context to resemble a long report. It includes quotations such as "hello" and ordinary punctuation.\n\n',
      fillerChars,
    );
  } else if (shape === "fenced-code") {
    filler = repeatedFiller(
      "const localValue = 12345; // representative fenced code line padded to keep line-count policy separate from source volume\n",
      fillerChars,
    );
  } else {
    throw new Error(`Unknown source-volume shape: ${shape}`);
  }

  return {
    content: `${prefix}${bodyPrefix}${filler}${suffix}`,
    sourceMarker,
  };
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function generateDocumentPerformanceFixtures(outputDirectory) {
  const outputDir = path.resolve(outputDirectory);
  await mkdir(outputDir, { recursive: true });

  const cases = [];
  const smartypantsCases = SMARTYPANTS_TARGETS.flatMap((assembledChars) =>
    SMARTYPANTS_SHAPES.map((shape) => ({ assembledChars, shape }))
  );
  smartypantsCases.push(
    { assembledChars: SMARTYPANTS_CURRENT_LIMIT_TARGET, shape: "punctuation" },
    { assembledChars: SMARTYPANTS_DEGRADED_TARGET, shape: "punctuation" },
  );
  for (const { assembledChars, shape } of smartypantsCases) {
    const fixture = createSmartypantsFixture(assembledChars, shape);
    const id = `smartypants-${shape}-${assembledChars}`;
    const fileName = `${id}.md`;
    await writeFile(path.join(outputDir, fileName), fixture.content, "utf8");
    cases.push({
      id,
      fileName,
      kind: "smartypants",
      shape,
      expected: assembledChars > SMARTYPANTS_CURRENT_LIMIT_TARGET ? "degraded" : "accepted",
      assembledSmartypantsChars: assembledChars,
      endMarker: fixture.endMarker,
      sourceCodeUnits: fixture.content.length,
      utf8Bytes: Buffer.byteLength(fixture.content, "utf8"),
      sha256: sha256(fixture.content),
    });
  }

  for (const sourceCodeUnits of MARKDOWN_SOURCE_SWEEP_CODE_UNITS) {
    for (const shape of MARKDOWN_SOURCE_SHAPES) {
      const fixture = sourceVolumeFixture(sourceCodeUnits, shape);
      const id = `source-${shape}-${sourceCodeUnits}`;
      const fileName = `${id}.md`;
      await writeFile(path.join(outputDir, fileName), fixture.content, "utf8");
      cases.push({
        id,
        fileName,
        kind: "source-volume",
        shape,
        expected: "accepted",
        endMarker: fixture.sourceMarker,
        sourceCodeUnits: fixture.content.length,
        utf8Bytes: Buffer.byteLength(fixture.content, "utf8"),
        sha256: sha256(fixture.content),
      });
    }
  }

  const refused = sourceVolumeFixture(
    MARKDOWN_SOURCE_REFUSAL_CODE_UNITS,
    "word-soup",
  );
  const refusedFileName = `source-word-soup-${MARKDOWN_SOURCE_REFUSAL_CODE_UNITS}.md`;
  await writeFile(path.join(outputDir, refusedFileName), refused.content, "utf8");
  cases.push({
    id: `source-word-soup-${MARKDOWN_SOURCE_REFUSAL_CODE_UNITS}`,
    fileName: refusedFileName,
    kind: "source-volume",
    shape: "word-soup",
    expected: "refused",
    sourceMarker: refused.sourceMarker,
    sourceCodeUnits: refused.content.length,
    utf8Bytes: Buffer.byteLength(refused.content, "utf8"),
    sha256: sha256(refused.content),
  });

  const controlMarker = "END_PERFORMANCE_CONTROL";
  const links = cases
    .filter((entry) => entry.kind === "smartypants")
    .map((entry) => `- [${entry.id}](./${entry.fileName})`)
    .join("\n");
  const control = `# Document performance control\n\n${links}\n\n${controlMarker}\n`;
  await writeFile(path.join(outputDir, "control.md"), control, "utf8");

  const coldControlFixture = createTinyColdControlFixture();
  const coldControl = {
    id: "cold-control-tiny",
    fileName: "cold-control-tiny.md",
    kind: "control",
    shape: "tiny",
    expected: "accepted",
    endMarker: coldControlFixture.endMarker,
    sourceCodeUnits: coldControlFixture.content.length,
    utf8Bytes: Buffer.byteLength(coldControlFixture.content, "utf8"),
    sha256: sha256(coldControlFixture.content),
  };
  await writeFile(
    path.join(outputDir, coldControl.fileName),
    coldControlFixture.content,
    "utf8",
  );

  const manifest = {
    schemaVersion: 2,
    coldControl,
    control: { fileName: "control.md", endMarker: controlMarker },
    cases,
  };
  await writeFile(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

async function main() {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    console.error("Usage: node scripts/generate-document-performance-fixtures.mjs OUTPUT_DIR");
    process.exitCode = 2;
    return;
  }
  const manifest = await generateDocumentPerformanceFixtures(outputDirectory);
  console.log(`Generated ${manifest.cases.length + 2} fixtures in ${path.resolve(outputDirectory)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
