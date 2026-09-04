import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(repoRoot, "third-party-software.json");
const noticesPath = path.join(repoRoot, "THIRD-PARTY-NOTICES");
const rootPackagePath = path.join(repoRoot, "package.json");
const packageLockPath = path.join(repoRoot, "package-lock.json");
const cargoLockPath = path.join(repoRoot, "src-tauri", "Cargo.lock");
const tauriConfigPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const cargoOverridesPath = path.join(
  repoRoot,
  "scripts",
  "license-overrides",
  "cargo-upstream.json",
);
const formatLicensePath = path.join(
  repoRoot,
  "scripts",
  "license-overrides",
  "npm-format-0.2.2.txt",
);
const remarkMathLicensePath = path.join(
  repoRoot,
  "scripts",
  "license-overrides",
  "npm-remark-math-mit.txt",
);
const retextLicensePath = path.join(
  repoRoot,
  "scripts",
  "license-overrides",
  "npm-retext-mit.txt",
);
const lgpl21LicensePath = path.join(
  repoRoot,
  "scripts",
  "license-overrides",
  "LGPL-2.1.txt",
);

const desktopTargets = [
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
];
const npmBuildOutputContributors = new Set(["tailwindcss", "vite"]);
const releaseBlockingClasses = new Set([
  "build-output-contributor",
  "runtime-dependency",
  "runtime-linked",
]);
const cargoSourceAvailability = new Map([
  [
    "cargo:option-ext@0.2.0",
    {
      url: "https://crates.io/api/v1/crates/option-ext/0.2.0/download",
      sha256: "04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d",
    },
  ],
]);
const standardMitLicenseText = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const documentPattern =
  /^(?:authors|license|licence|copying|copyright|notice|unlicense)(?:[-._].*)?$/i;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const lastMarker = lockPath.lastIndexOf(marker);
  if (lastMarker === -1) {
    throw new Error(`Cannot derive an npm package name from ${lockPath}`);
  }

  const remainder = lockPath.slice(lastMarker + marker.length);
  const parts = remainder.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function deduplicatePackages(packages, ecosystem) {
  const byId = new Map();
  for (const packageEntry of packages) {
    if (byId.has(packageEntry.id)) {
      throw new Error(
        `${ecosystem} inventory key collision for ${packageEntry.id}; ` +
          "extend the inventory key before reviewing this lockfile",
      );
    }
    byId.set(packageEntry.id, packageEntry);
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function npmLockPackages(packageLock) {
  const packages = [];
  for (const [lockPath, metadata] of Object.entries(packageLock.packages ?? {})) {
    if (!lockPath) continue;
    if (!metadata.version) {
      throw new Error(`npm lock entry ${lockPath} has no version`);
    }

    const name = packageNameFromLockPath(lockPath);
    const buildOutputContributor = npmBuildOutputContributors.has(name);
    if (metadata.dev && !buildOutputContributor) continue;
    packages.push({
      id: `npm:${name}@${metadata.version}`,
      kind: "npm",
      name,
      version: metadata.version,
      lockPath,
      distributionClass: buildOutputContributor
        ? "build-output-contributor"
        : "runtime-dependency",
    });
  }

  return deduplicatePackages(packages, "npm");
}

function cargoField(block, field, required = true) {
  const match = block.match(new RegExp(`^${field} = ("(?:[^"\\\\]|\\\\.)*")$`, "m"));
  if (!match) {
    if (required) throw new Error(`Cargo.lock package is missing ${field}`);
    return null;
  }
  return JSON.parse(match[1]);
}

export function cargoLockPackages(cargoLock, rootPackage) {
  const packages = [];
  for (const block of cargoLock.split(/\n(?=\[\[package\]\]\n)/)) {
    if (!block.startsWith("[[package]]")) continue;

    const name = cargoField(block, "name");
    const version = cargoField(block, "version");
    const source = cargoField(block, "source", false);
    const checksum = cargoField(block, "checksum", false);
    if (
      name === rootPackage.name &&
      version === rootPackage.version &&
      source === null
    ) {
      continue;
    }

    packages.push({
      id: `cargo:${name}@${version}`,
      kind: "cargo",
      name,
      version,
      source,
      checksum,
    });
  }

  return deduplicatePackages(packages, "Cargo");
}

function normalizePerson(person) {
  if (typeof person === "string") return person.trim();
  if (!person || typeof person !== "object") return null;

  const contact = [person.email, person.url].filter(Boolean).join(", ");
  return contact ? `${person.name ?? "Unknown"} <${contact}>` : person.name ?? null;
}

function npmAuthors(manifest) {
  const people = [
    manifest.author,
    ...(manifest.contributors ?? []),
    ...(manifest.maintainers ?? []),
  ]
    .map(normalizePerson)
    .filter(Boolean);
  return [...new Set(people)];
}

function repositoryUrl(repository) {
  if (typeof repository === "string") return repository;
  if (repository && typeof repository.url === "string") return repository.url;
  return null;
}

function rootDocumentFiles(packageDirectory, explicitLicenseFile = null) {
  const files = new Set();
  for (const entry of readdirSync(packageDirectory, { withFileTypes: true })) {
    if (entry.isFile() && documentPattern.test(entry.name)) {
      files.add(path.join(packageDirectory, entry.name));
    }
  }

  if (explicitLicenseFile) {
    const explicitPath = path.resolve(packageDirectory, explicitLicenseFile);
    if (existsSync(explicitPath) && statSync(explicitPath).isFile()) {
      files.add(explicitPath);
    }
  }

  return [...files].sort();
}

function detectedLicenseIds(text) {
  const ids = new Set();
  const normalized = normalizeDocumentText(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  if (
    /Permission is hereby granted, free of charge,[\s\S]*The above copyright notice and this permission notice[\s\S]*THE SOFTWARE IS PROVIDED ["']AS IS["']/i.test(
      normalized,
    )
  ) {
    ids.add("MIT");
  }
  if (/Apache License[\s\S]{0,120}Version 2\.0[\s\S]{0,240}TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/i.test(normalized)) {
    ids.add("Apache-2.0");
    if (/LLVM Exceptions? to the Apache 2\.0 License/i.test(normalized)) {
      ids.add("Apache-2.0 WITH LLVM-exception");
    }
  }
  if (/Redistribution and use in source and binary forms[\s\S]*Neither the name/i.test(normalized)) {
    ids.add("BSD-3-Clause");
  } else if (/Redistribution and use in source and binary forms[\s\S]*THIS (?:SOFTWARE )?IS PROVIDED/i.test(normalized)) {
    ids.add("BSD-2-Clause");
  }
  if (/Mozilla Public License Version 2\.0/i.test(normalized)) ids.add("MPL-2.0");
  if (/SIL OPEN FONT LICENSE Version 1\.1/i.test(normalized)) ids.add("OFL-1.1");
  if (/Unicode License V3/i.test(normalized)) ids.add("Unicode-3.0");
  if (/CC0 1\.0 Universal/i.test(normalized)) ids.add("CC0-1.0");
  if (/This is free and unencumbered software released into the public domain/i.test(normalized)) {
    ids.add("Unlicense");
  }
  if (/Boost Software License[\s\S]{0,80}Version 1\.0/i.test(normalized)) {
    ids.add("BSL-1.0");
  }
  if (/Permission to use, copy, modify, and(?:\/or)? distribute this software for any\s+purpose[\s\S]{0,40}with or without fee is hereby granted/i.test(normalized)) {
    ids.add(/THE SOFTWARE IS PROVIDED ["']AS IS["']/i.test(normalized) ? "ISC" : "0BSD");
  }
  if (/This software is provided ['"]as-is['"][\s\S]*altered source versions must be plainly marked/i.test(normalized)) {
    ids.add("Zlib");
  }
  if (/PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/i.test(normalized)) {
    ids.add("Python-2.0");
  }

  return ids;
}

function isSubstantiveLicenseText(text) {
  return detectedLicenseIds(text).size > 0;
}

function normalizedLicenseExpression(expression) {
  return expression.replace(/\s*\/\s*/g, " OR ").replace(/[()]/g, "").trim();
}

function licenseExpressionGroups(expression) {
  return normalizedLicenseExpression(expression)
    .split(/\s+AND\s+/i)
    .map((group) => group.split(/\s+OR\s+/i).map((license) => license.trim()));
}

function licenseCoverage(expression, documentTexts, selectedLicense = null) {
  const detected = new Set();
  for (const text of documentTexts) {
    for (const licenseId of detectedLicenseIds(text)) detected.add(licenseId);
  }

  const groups = licenseExpressionGroups(expression);
  if (selectedLicense) {
    const selectedGroup = groups.find((group) => group.includes(selectedLicense));
    return {
      detected,
      satisfied:
        Boolean(selectedGroup) &&
        groups.every((group) =>
          group === selectedGroup
            ? detected.has(selectedLicense)
            : group.some((licenseId) => detected.has(licenseId)),
        ),
    };
  }

  return {
    detected,
    satisfied: groups.every((group) => group.some((licenseId) => detected.has(licenseId))),
  };
}

function selectedLicenseFor(expression, documentTexts, explicitSelection = null) {
  if (explicitSelection) return explicitSelection;
  const groups = licenseExpressionGroups(expression);
  const choiceGroup = groups.find((group) => group.length > 1);
  if (!choiceGroup) return null;

  const detected = new Set();
  for (const text of documentTexts) {
    for (const licenseId of detectedLicenseIds(text)) detected.add(licenseId);
  }
  const preference = [
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "BSD-2-Clause",
    "ISC",
    "Zlib",
    "0BSD",
    "Unlicense",
  ];
  return preference.find(
    (licenseId) => choiceGroup.includes(licenseId) && detected.has(licenseId),
  ) ?? null;
}

function hasRequiredLicenseText(expression, documentTexts, selectedLicense = null) {
  const substantive = documentTexts.some(isSubstantiveLicenseText);
  if (!substantive) return false;
  if (selectedLicense || /\b(?:AND|OR)\b|\//.test(expression)) {
    return licenseCoverage(expression, documentTexts, selectedLicense).satisfied;
  }
  return true;
}

export function licenseEvidenceSatisfies(
  expression,
  documentTexts,
  selectedLicense = null,
) {
  return hasRequiredLicenseText(expression, documentTexts, selectedLicense);
}

function normalizedDocumentText(filePath) {
  return normalizeDocumentText(readFileSync(filePath, "utf8"));
}

function normalizeDocumentText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function packagedReadmeLicense(packageDirectory) {
  const readmePath = ["README.md", "readme.md"]
    .map((name) => path.join(packageDirectory, name))
    .find(existsSync);
  if (!readmePath) return null;

  const readme = readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");
  const match = readme.match(
    /^## License\n\n([\s\S]*?)(?=\n## |\n<!-- |(?![\s\S]))/m,
  );
  return match?.[1].trim() ?? null;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function addDocument(documents, packageEntry, source, text) {
  if (!text) return null;

  const id = `sha256:${sha256(text)}`;
  const document = documents.get(id) ?? {
    id,
    packages: new Set(),
    sources: new Set(),
    text,
  };
  document.packages.add(packageEntry.id);
  document.sources.add(source);
  documents.set(id, document);
  return id;
}

function loadCargoMetadata() {
  const output = execFileSync(
    cargoExecutable(),
    ["metadata", "--locked", "--format-version", "1"],
    {
      cwd: path.join(repoRoot, "src-tauri"),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(output);
}

function cargoExecutable() {
  const rustupCargo = path.join(homedir(), ".cargo", "bin", "cargo");
  return process.env.CARGO ?? (existsSync(rustupCargo) ? rustupCargo : "cargo");
}

export function loadDesktopRuntimeCargoIds() {
  const ids = new Set();
  for (const target of desktopTargets) {
    const output = execFileSync(
      cargoExecutable(),
      [
        "tree",
        "--locked",
        "--offline",
        "--target",
        target,
        "--edges",
        "normal,no-proc-macro",
        "--prefix",
        "none",
        "--format",
        "{p}",
      ],
      {
        cwd: path.join(repoRoot, "src-tauri"),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    for (const line of output.split("\n")) {
      const match = line.match(/^(\S+) v(\S+)/);
      if (!match) continue;
      const [, name, version] = match;
      ids.add(`cargo:${name}@${version}`);
    }
  }
  return ids;
}

function cargoMetadataKey(packageEntry) {
  return `${packageEntry.name}\0${packageEntry.version}\0${packageEntry.source ?? ""}`;
}

function generateNpmEntries(lockPackages, documents) {
  return lockPackages.map((lockEntry) => {
    const packageDirectory = path.join(repoRoot, lockEntry.lockPath);
    const manifest = readJson(path.join(packageDirectory, "package.json"));
    let declaredLicense = manifest.license ?? null;
    let evidence = null;
    let documentFiles = rootDocumentFiles(packageDirectory);
    let additionalDocumentRef = null;

    if (lockEntry.name === "format" && lockEntry.version === "0.2.2") {
      declaredLicense = "MIT";
      evidence = "https://github.com/samsonjs/format/blob/main/License.md";
      documentFiles = [formatLicensePath];
    } else if (["rehype-katex", "remark-math"].includes(lockEntry.name)) {
      evidence = "https://github.com/remarkjs/remark-math/blob/main/license";
      documentFiles = [remarkMathLicensePath];
    } else if (
      ["retext", "retext-latin", "retext-stringify"].includes(lockEntry.name)
    ) {
      evidence = "https://github.com/retextjs/retext/blob/main/license";
      documentFiles = [retextLicensePath];
    } else if (lockEntry.name === "khroma" && lockEntry.version === "2.1.0") {
      declaredLicense = "MIT";
      evidence = "Packaged license file: node_modules/khroma/license";
    } else if (["fastdom", "strictdom"].includes(lockEntry.name)) {
      const readmeLicense = packagedReadmeLicense(packageDirectory);
      if (!readmeLicense) {
        throw new Error(`${lockEntry.id} no longer has its expected README license`);
      }
      additionalDocumentRef = addDocument(
        documents,
        lockEntry,
        "README.md#license",
        readmeLicense,
      );
      evidence = "Packaged README.md License section";
      documentFiles = [];
    } else if (lockEntry.name.startsWith("@tauri-apps/plugin-")) {
      const tauriApiDirectory = path.join(repoRoot, "node_modules", "@tauri-apps", "api");
      documentFiles = [
        ...documentFiles,
        path.join(tauriApiDirectory, "LICENSE_APACHE-2.0"),
        path.join(tauriApiDirectory, "LICENSE_MIT"),
      ];
      evidence = "Packaged Tauri project license texts from @tauri-apps/api";
    }

    if (!declaredLicense) {
      throw new Error(`${lockEntry.id} has no declared license and no reviewed override`);
    }

    const documentRefs = [
      additionalDocumentRef,
      ...documentFiles
        .map((filePath) =>
          addDocument(
            documents,
            lockEntry,
            path.basename(filePath),
            normalizedDocumentText(filePath),
          ),
        )
        .filter(Boolean),
    ].filter(Boolean);
    const fontMetadataPath = path.join(packageDirectory, "metadata.json");
    const fontMetadata = existsSync(fontMetadataPath) ? readJson(fontMetadataPath) : null;
    const attribution = fontMetadata?.license?.attribution ?? null;
    const explicitSelectedLicense =
      lockEntry.name === "dompurify" && lockEntry.version === "3.4.14"
        ? "Apache-2.0"
        : null;
    const documentTexts = documentRefs.map((documentRef) => documents.get(documentRef).text);
    const selectedLicense = selectedLicenseFor(
      declaredLicense,
      documentTexts,
      explicitSelectedLicense,
    );
    const licenseTextAvailable = hasRequiredLicenseText(
      declaredLicense,
      documentTexts,
      selectedLicense,
    );
    const releaseBlocking = releaseBlockingClasses.has(lockEntry.distributionClass);
    const reviewRequired = releaseBlocking && !licenseTextAvailable;

    return {
      ...lockEntry,
      declaredLicense,
      authors: npmAuthors(manifest),
      repository: repositoryUrl(manifest.repository) ?? manifest.homepage ?? null,
      attribution,
      selectedLicense,
      disposition: reviewRequired
        ? "declared-license-metadata-only"
        : evidence?.startsWith("https://")
          ? "reviewed-upstream-license-override"
          : "packaged-license-document",
      evidence,
      licenseTextAvailable,
      reviewRequired,
      inventoryWarning: !releaseBlocking && !licenseTextAvailable,
      documentRefs: [...new Set(documentRefs)].sort(),
    };
  });

}

function generateCargoEntries(lockPackages, documents, overrides, runtimeCargoIds) {
  if (overrides.schemaVersion !== 1) {
    throw new Error(`Unsupported Cargo override schema: ${overrides.schemaVersion}`);
  }
  const metadataByKey = new Map(
    loadCargoMetadata().packages.map((packageEntry) => [
      cargoMetadataKey(packageEntry),
      packageEntry,
    ]),
  );

  const entries = lockPackages.map((lockEntry) => {
    const packageMetadata = metadataByKey.get(cargoMetadataKey(lockEntry));
    if (!packageMetadata) {
      throw new Error(`cargo metadata did not resolve ${lockEntry.id}`);
    }
    if (!packageMetadata.license) {
      throw new Error(`${lockEntry.id} has no declared license`);
    }

    const packageDirectory = path.dirname(packageMetadata.manifest_path);
    const override = overrides.packages[lockEntry.id] ?? null;
    const localDocumentFiles = rootDocumentFiles(
      packageDirectory,
      packageMetadata.license_file,
    );
    const overrideDocumentRefs = (override?.documents ?? []).map((documentKey) => {
      const document = overrides.documents[documentKey];
      if (!document?.source || !document?.text) {
        throw new Error(`${lockEntry.id} has an invalid override document: ${documentKey}`);
      }
      return addDocument(
        documents,
        lockEntry,
        document.source,
        normalizeDocumentText(document.text),
      );
    });
    const documentRefs = [
      ...localDocumentFiles
        .map((filePath) =>
          addDocument(
            documents,
            lockEntry,
            path.basename(filePath),
            normalizedDocumentText(filePath),
          ),
        )
        .filter(Boolean),
      ...overrideDocumentRefs,
    ];
    let documentTexts = documentRefs.map((documentRef) => documents.get(documentRef).text);
    const distributionClass = runtimeCargoIds.has(lockEntry.id)
      ? "runtime-linked"
      : "inventory-only";
    const standardLicenseOverride = override?.standardLicense ?? null;
    if (standardLicenseOverride) {
      if (standardLicenseOverride !== "MIT") {
        throw new Error(
          `${lockEntry.id} has unsupported standard license override ${standardLicenseOverride}`,
        );
      }
      if (!override.evidence) {
        throw new Error(`${lockEntry.id} standard license override lacks review evidence`);
      }
      if (
        !licenseExpressionGroups(packageMetadata.license).some((group) =>
          group.includes(standardLicenseOverride),
        )
      ) {
        throw new Error(
          `${lockEntry.id} does not declare ${standardLicenseOverride} as a license option`,
        );
      }
      if (
        documentTexts.some((text) =>
          detectedLicenseIds(text).has(standardLicenseOverride),
        )
      ) {
        throw new Error(`${lockEntry.id} standard license override is no longer needed`);
      }
      const standardMitRef = addDocument(
        documents,
        lockEntry,
        "https://opensource.org/license/mit",
        standardMitLicenseText,
      );
      documentRefs.push(standardMitRef);
      documentTexts = documentRefs.map((documentRef) => documents.get(documentRef).text);
    }
    const selectedLicense = selectedLicenseFor(
      packageMetadata.license,
      documentTexts,
      override?.selectedLicense ?? null,
    );
    const licenseTextAvailable = hasRequiredLicenseText(
      packageMetadata.license,
      documentTexts,
      selectedLicense,
    );
    const reviewRequired =
      releaseBlockingClasses.has(distributionClass) && !licenseTextAvailable;
    const sourceAvailability =
      override?.sourceAvailability ?? cargoSourceAvailability.get(lockEntry.id) ?? null;
    if (
      sourceAvailability?.sha256 &&
      lockEntry.checksum &&
      sourceAvailability.sha256 !== lockEntry.checksum
    ) {
      throw new Error(`${lockEntry.id} corresponding-source checksum does not match Cargo.lock`);
    }

    let disposition = "packaged-license-document";
    if (overrideDocumentRefs.length > 0) {
      disposition = "reviewed-upstream-license-override";
    }
    if (standardLicenseOverride) {
      disposition = "reviewed-standard-license-override";
    }
    if (reviewRequired) {
      disposition = "declared-license-metadata-only";
    }

    return {
      ...lockEntry,
      declaredLicense: packageMetadata.license,
      authors: packageMetadata.authors,
      repository: packageMetadata.repository ?? packageMetadata.homepage ?? null,
      attribution: null,
      distributionClass,
      selectedLicense,
      standardLicenseOverride,
      sourceAvailability,
      disposition,
      evidence: override?.evidence ?? null,
      licenseTextAvailable,
      reviewRequired,
      inventoryWarning: !reviewRequired && !licenseTextAvailable,
      documentRefs: [...new Set(documentRefs)].sort(),
    };
  });

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    const override = overrides.packages[entry.id];
    for (const donorId of override?.donors ?? []) {
      const donor = entriesById.get(donorId);
      if (!donor || donor.documentRefs.length === 0) {
        throw new Error(`${entry.id} has an invalid license-document donor: ${donorId}`);
      }
      for (const documentRef of donor.documentRefs) {
        entry.documentRefs.push(documentRef);
        documents.get(documentRef).packages.add(entry.id);
      }
    }
    entry.documentRefs = [...new Set(entry.documentRefs)].sort();
    const documentTexts = entry.documentRefs.map(
      (documentRef) => documents.get(documentRef).text,
    );
    entry.selectedLicense = selectedLicenseFor(
      entry.declaredLicense,
      documentTexts,
      override?.selectedLicense ?? entry.selectedLicense,
    );
    entry.licenseTextAvailable = hasRequiredLicenseText(
      entry.declaredLicense,
      documentTexts,
      entry.selectedLicense,
    );
    entry.reviewRequired =
      releaseBlockingClasses.has(entry.distributionClass) && !entry.licenseTextAvailable;
    entry.inventoryWarning = !entry.reviewRequired && !entry.licenseTextAvailable;
    if (entry.licenseTextAvailable && override?.donors?.length > 0) {
      entry.disposition = "reviewed-package-family-license-override";
    }
  }

  return entries;
}

function serializeDocuments(documents) {
  return [...documents.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((document) => ({
      id: document.id,
      packages: [...document.packages].sort(),
      sources: [...document.sources].sort(),
      text: document.text,
    }));
}

function packageLines(packageEntry) {
  const lines = [
    `Package-ID: ${packageEntry.id}`,
    `License: ${packageEntry.declaredLicense}`,
    `Distribution-class: ${packageEntry.distributionClass}`,
    `Disposition: ${packageEntry.disposition}`,
  ];
  if (packageEntry.selectedLicense) {
    lines.push(`License-choice: ${packageEntry.selectedLicense}`);
  }
  if (packageEntry.standardLicenseOverride) {
    lines.push(`Standard-license-override: ${packageEntry.standardLicenseOverride}`);
  }
  if (packageEntry.authors.length > 0) {
    lines.push(`Authors: ${packageEntry.authors.join("; ")}`);
  }
  if (packageEntry.repository) lines.push(`Project: ${packageEntry.repository}`);
  if (packageEntry.attribution) lines.push(`Attribution: ${packageEntry.attribution}`);
  if (packageEntry.evidence) lines.push(`Evidence: ${packageEntry.evidence}`);
  if (packageEntry.sourceAvailability) {
    lines.push(`Corresponding-source: ${packageEntry.sourceAvailability.url}`);
    if (packageEntry.sourceAvailability.sha256) {
      lines.push(`Corresponding-source-sha256: ${packageEntry.sourceAvailability.sha256}`);
    }
  }
  lines.push(
    `License-text: ${packageEntry.licenseTextAvailable ? "available" : "unresolved"}`,
  );
  if (packageEntry.reviewRequired) lines.push("Human-review: required");
  if (packageEntry.inventoryWarning) lines.push("Inventory-warning: license text unresolved");
  for (const documentRef of packageEntry.documentRefs) {
    lines.push(`License-document-ref: ${documentRef}`);
  }
  return lines.join("\n");
}

function renderNotices(inventory, lgpl21LicenseText) {
  const reviewRequired = inventory.packages.filter(
    (packageEntry) => packageEntry.reviewRequired,
  );
  const inventoryWarnings = inventory.packages.filter(
    (packageEntry) => packageEntry.inventoryWarning,
  );
  const standardLicenseOverrides = inventory.packages.filter(
    (packageEntry) => packageEntry.standardLicenseOverride,
  );
  const sections = [
    "Bindars Third-Party Software Notices",
    "====================================",
    "",
    "This file is generated by `npm run licenses:generate`. Do not edit it by hand.",
    "",
    "Inventory scope",
    "---------------",
    "",
    "The inventory conservatively covers every non-development npm package, Vite",
    "and Tailwind CSS as build-output contributors, and every third-party Rust",
    "package in src-tauri/Cargo.lock. Rust packages are classified using the union",
    "of the supported macOS, Windows, and Linux linked-runtime graphs.",
    "",
    `Inventoried npm packages: ${inventory.summary.npmPackages}`,
    `Inventoried Rust packages: ${inventory.summary.cargoPackages}`,
    `Distinct license/notice documents: ${inventory.summary.documents}`,
    `Packages requiring human follow-up: ${inventory.summary.reviewRequired}`,
    `Inventory-only unresolved packages: ${inventory.summary.inventoryWarnings}`,
    `Reviewed standard-license overrides: ${inventory.summary.standardLicenseOverrides}`,
    "",
    "`Human-review: required` blocks distribution because a runtime or build-output",
    "entry lacks complete license evidence. `Inventory-warning` records the same gap",
    "for a lockfile-only package, but does not block a release because that package",
    "does not enter a supported desktop linked-runtime graph.",
    "",
  ];

  if (reviewRequired.length > 0) {
    sections.push(
      "Human follow-up queue",
      "---------------------",
      "",
      ...reviewRequired.map((packageEntry) => packageEntry.id),
      "",
    );
  }

  if (inventoryWarnings.length > 0) {
    sections.push(
      "Non-blocking inventory warnings",
      "-------------------------------",
      "",
      ...inventoryWarnings.map((packageEntry) => packageEntry.id),
      "",
    );
  }

  if (standardLicenseOverrides.length > 0) {
    sections.push(
      "Reviewed standard-license overrides",
      "-----------------------------------",
      "",
      "These packages declare the named license but package only a pointer or copyright",
      "notice. Their individually reviewed override records supply the standard text:",
      "",
      ...standardLicenseOverrides.map(
        (packageEntry) =>
          `${packageEntry.id} — ${packageEntry.standardLicenseOverride}`,
      ),
      "",
    );
  }

  sections.push(
    "Linux system libraries",
    "----------------------",
    "",
    "The Debian package does not contain WebKitGTK or GTK. Its executable dynamically",
    "loads the operating system packages libwebkit2gtk-4.1-0 and libgtk-3-0. Bindars",
    "identifies these libraries and their terms here as a conservative compliance step:",
    "",
    "- WebKitGTK 4.1 — BSD and GNU LGPL 2.1; https://webkitgtk.org/",
    "- GTK 3 — GNU LGPL 2.1 or later; https://www.gtk.org/",
    "- GNU LGPL 2.1 canonical source: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt",
    "",
    "GNU Lesser General Public License 2.1",
    "-------------------------------------",
    "",
    lgpl21LicenseText,
    "",
  );

  sections.push("Package index", "-------------", "");
  for (const packageEntry of inventory.packages) {
    sections.push(packageLines(packageEntry), "");
  }

  sections.push("License and notice documents", "----------------------------", "");
  for (const document of inventory.documents) {
    sections.push(
      `License-Document: ${document.id}`,
      `Applies-to: ${document.packages.join(", ")}`,
      `Source-files: ${document.sources.join(", ")}`,
      "",
      document.text,
      "",
      `License-Document-End: ${document.id}`,
      "--------------------------------------------------------------------------------",
      "",
    );
  }

  return `${sections.join("\n").trimEnd()}\n`;
}

export function buildRepositoryOutputs() {
  const rootPackage = readJson(rootPackagePath);
  const npmPackages = npmLockPackages(readJson(packageLockPath));
  const cargoPackages = cargoLockPackages(
    readFileSync(cargoLockPath, "utf8"),
    rootPackage,
  );
  const runtimeCargoIds = loadDesktopRuntimeCargoIds();
  const documents = new Map();
  const cargoOverrides = readJson(cargoOverridesPath);
  const lockedCargoIds = new Set(cargoPackages.map(({ id }) => id));
  const staleOverrides = Object.keys(cargoOverrides.packages).filter(
    (packageId) => !lockedCargoIds.has(packageId),
  );
  if (staleOverrides.length > 0) {
    throw new Error(`Cargo overrides are stale: ${staleOverrides.join(", ")}`);
  }
  const packages = [
    ...generateNpmEntries(npmPackages, documents),
    ...generateCargoEntries(cargoPackages, documents, cargoOverrides, runtimeCargoIds),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const serializedDocuments = serializeDocuments(documents);
  const inventory = {
    schemaVersion: 1,
    generatedFrom: {
      npm: "package-lock.json non-development packages plus Vite and Tailwind CSS build output",
      cargo: "src-tauri/Cargo.lock third-party packages",
    },
    summary: {
      npmPackages: npmPackages.length,
      cargoPackages: cargoPackages.length,
      documents: serializedDocuments.length,
      reviewRequired: packages.filter((packageEntry) => packageEntry.reviewRequired)
        .length,
      inventoryWarnings: packages.filter((packageEntry) => packageEntry.inventoryWarning)
        .length,
      standardLicenseOverrides: packages.filter(
        (packageEntry) => packageEntry.standardLicenseOverride,
      ).length,
    },
    packages,
    documents: serializedDocuments.map(({ text: _text, ...document }) => document),
  };

  const inventoryText = `${JSON.stringify(inventory, null, 2)}\n`;
  const notices = renderNotices(
    { ...inventory, documents: serializedDocuments },
    readFileSync(lgpl21LicensePath, "utf8"),
  );
  return { inventory, inventoryText, notices };
}

export function generateRepositoryInventory() {
  const outputs = buildRepositoryOutputs();
  writeFileSync(inventoryPath, outputs.inventoryText);
  writeFileSync(noticesPath, outputs.notices);
  return outputs.inventory.summary;
}

export function compareGeneratedOutputs(
  { inventoryText, notices },
  { inventoryText: expectedInventoryText, notices: expectedNotices },
) {
  const errors = [];
  if (inventoryText.replace(/\r\n/g, "\n") !== expectedInventoryText) {
    errors.push(
      "third-party-software.json is stale or modified; run npm run licenses:generate",
    );
  }
  if (notices.replace(/\r\n/g, "\n") !== expectedNotices) {
    errors.push("THIRD-PARTY-NOTICES is stale or modified; run npm run licenses:generate");
  }
  return errors;
}

function difference(expected, actual) {
  return [...expected].filter((value) => !actual.has(value)).sort();
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function collectVerificationErrors({
  inventory,
  packageLock,
  cargoLock,
  rootPackage,
  notices,
  tauriConfig,
  cargoOverrides,
}) {
  const errors = [];
  const expectedPackages = [
    ...npmLockPackages(packageLock),
    ...cargoLockPackages(cargoLock, rootPackage),
  ];
  const expectedIds = new Set(expectedPackages.map((packageEntry) => packageEntry.id));
  const inventoryIds = new Set(inventory.packages.map((packageEntry) => packageEntry.id));
  const reviewRequiredIds = inventory.packages
    .filter((packageEntry) => packageEntry.reviewRequired)
    .map((packageEntry) => packageEntry.id)
    .sort();

  if (inventory.schemaVersion !== 1) {
    errors.push(`Unsupported inventory schema version: ${inventory.schemaVersion}`);
  }
  if (reviewRequiredIds.length > 0) {
    errors.push(
      `Packages require human license review before distribution: ${reviewRequiredIds.join(", ")}`,
    );
  }

  const missing = difference(expectedIds, inventoryIds);
  const stale = difference(inventoryIds, expectedIds);
  if (missing.length > 0) {
    errors.push(`Inventory is missing locked packages: ${missing.join(", ")}`);
  }
  if (stale.length > 0) {
    errors.push(`Inventory contains stale packages: ${stale.join(", ")}`);
  }

  const inventoryDuplicates = duplicateValues(
    inventory.packages.map((packageEntry) => packageEntry.id),
  );
  if (inventoryDuplicates.length > 0) {
    errors.push(`Inventory contains duplicate package IDs: ${inventoryDuplicates.join(", ")}`);
  }

  const directDependencies = Object.keys(rootPackage.dependencies ?? {}).map((name) => {
    const lockEntry = packageLock.packages?.[`node_modules/${name}`];
    return lockEntry ? `npm:${name}@${lockEntry.version}` : `npm:${name}@<unlocked>`;
  });
  const uncoveredDirectDependencies = directDependencies.filter(
    (packageId) => !inventoryIds.has(packageId),
  );
  if (uncoveredDirectDependencies.length > 0) {
    errors.push(
      `Direct runtime dependencies are not inventoried: ${uncoveredDirectDependencies.join(", ")}`,
    );
  }

  const documentIds = new Set(inventory.documents.map((document) => document.id));
  const documentDuplicates = duplicateValues(
    inventory.documents.map((document) => document.id),
  );
  if (documentDuplicates.length > 0) {
    errors.push(`Inventory contains duplicate document IDs: ${documentDuplicates.join(", ")}`);
  }
  for (const packageEntry of inventory.packages) {
    if (!packageEntry.declaredLicense) {
      errors.push(`${packageEntry.id} has no declared license or reviewed override`);
    }
    if (!packageEntry.disposition) {
      errors.push(`${packageEntry.id} has no review disposition`);
    }
    if (!packageEntry.distributionClass) {
      errors.push(`${packageEntry.id} has no distribution classification`);
    }
    if (
      !packageEntry.licenseTextAvailable &&
      !packageEntry.reviewRequired &&
      !packageEntry.inventoryWarning
    ) {
      errors.push(`${packageEntry.id} lacks license text and any review status`);
    }
    if (packageEntry.licenseTextAvailable && packageEntry.reviewRequired) {
      errors.push(`${packageEntry.id} has license text but remains flagged for human review`);
    }
    if (packageEntry.reviewRequired && !releaseBlockingClasses.has(packageEntry.distributionClass)) {
      errors.push(`${packageEntry.id} is non-distributed but incorrectly blocks release`);
    }
    if (packageEntry.inventoryWarning && releaseBlockingClasses.has(packageEntry.distributionClass)) {
      errors.push(`${packageEntry.id} is distributed but has only a non-blocking warning`);
    }
    if (packageEntry.licenseTextAvailable && packageEntry.inventoryWarning) {
      errors.push(`${packageEntry.id} has license text but remains an inventory warning`);
    }
    if (packageEntry.selectedLicense) {
      const documentTexts = packageEntry.documentRefs
        .map((documentRef) => inventory.documents.find(({ id }) => id === documentRef))
        .filter(Boolean)
        .map((document) => {
          const match = notices.match(
            new RegExp(
              `^License-Document: ${document.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nApplies-to:.*\\nSource-files:.*\\n\\n([\\s\\S]*?)\\n\\nLicense-Document-End:`,
              "m",
            ),
          );
          return match?.[1] ?? "";
        });
      if (!licenseCoverage(packageEntry.declaredLicense, documentTexts, packageEntry.selectedLicense).satisfied) {
        errors.push(`${packageEntry.id} does not substantiate selected license ${packageEntry.selectedLicense}`);
      }
    }
    for (const documentRef of packageEntry.documentRefs) {
      if (!documentIds.has(documentRef)) {
        errors.push(`${packageEntry.id} references missing document ${documentRef}`);
      } else {
        const document = inventory.documents.find(({ id }) => id === documentRef);
        if (!document.packages.includes(packageEntry.id)) {
          errors.push(
            `${packageEntry.id} references ${documentRef}, but the document omits that package`,
          );
        }
      }
    }
  }

  for (const document of inventory.documents) {
    for (const packageId of document.packages) {
      if (!inventoryIds.has(packageId)) {
        errors.push(`License document ${document.id} references unknown package ${packageId}`);
      } else {
        const packageEntry = inventory.packages.find(({ id }) => id === packageId);
        if (!packageEntry.documentRefs.includes(document.id)) {
          errors.push(
            `License document ${document.id} references ${packageId}, but the package omits it`,
          );
        }
      }
    }
  }

  if (cargoOverrides.schemaVersion !== 1) {
    errors.push(`Unsupported Cargo override schema: ${cargoOverrides.schemaVersion}`);
  }
  const usedOverrideDocuments = new Set();
  for (const [packageId, override] of Object.entries(cargoOverrides.packages)) {
    const packageEntry = inventory.packages.find(({ id }) => id === packageId);
    if (!packageEntry) {
      errors.push(`Cargo override references an unknown package: ${packageId}`);
      continue;
    }
    if (packageEntry.evidence !== override.evidence) {
      errors.push(`${packageId} does not preserve its Cargo override evidence`);
    }
    if (
      (packageEntry.standardLicenseOverride ?? null) !==
      (override.standardLicense ?? null)
    ) {
      errors.push(`${packageId} does not preserve its standard license override`);
    }
    for (const documentKey of override.documents ?? []) {
      usedOverrideDocuments.add(documentKey);
      const overrideDocument = cargoOverrides.documents[documentKey];
      if (!overrideDocument?.source || !overrideDocument?.text) {
        errors.push(`${packageId} has an invalid override document: ${documentKey}`);
        continue;
      }
      const documentRef = `sha256:${sha256(normalizeDocumentText(overrideDocument.text))}`;
      const inventoryDocument = inventory.documents.find(({ id }) => id === documentRef);
      if (!packageEntry.documentRefs.includes(documentRef)) {
        errors.push(`${packageId} omits its override document: ${documentKey}`);
      }
      if (!inventoryDocument?.sources.includes(overrideDocument.source)) {
        errors.push(`${documentKey} does not preserve its upstream source`);
      }
    }
    for (const donorId of override.donors ?? []) {
      const donor = inventory.packages.find(({ id }) => id === donorId);
      if (!donor) {
        errors.push(`${packageId} has an unknown license-document donor: ${donorId}`);
        continue;
      }
      const missingDonorDocuments = donor.documentRefs.filter(
        (documentRef) => !packageEntry.documentRefs.includes(documentRef),
      );
      if (missingDonorDocuments.length > 0) {
        errors.push(`${packageId} omits documents from donor ${donorId}`);
      }
    }
  }
  const unusedOverrideDocuments = Object.keys(cargoOverrides.documents).filter(
    (documentKey) => !usedOverrideDocuments.has(documentKey),
  );
  if (unusedOverrideDocuments.length > 0) {
    errors.push(`Cargo override contains unused documents: ${unusedOverrideDocuments.join(", ")}`);
  }

  const actualSummary = {
    npmPackages: inventory.packages.filter(({ kind }) => kind === "npm").length,
    cargoPackages: inventory.packages.filter(({ kind }) => kind === "cargo").length,
    documents: inventory.documents.length,
    reviewRequired: inventory.packages.filter(({ reviewRequired }) => reviewRequired)
      .length,
    inventoryWarnings: inventory.packages.filter(({ inventoryWarning }) => inventoryWarning)
      .length,
    standardLicenseOverrides: inventory.packages.filter(
      ({ standardLicenseOverride }) => standardLicenseOverride,
    ).length,
  };
  for (const [field, value] of Object.entries(actualSummary)) {
    if (inventory.summary?.[field] !== value) {
      errors.push(
        `Inventory summary ${field} is ${inventory.summary?.[field]}, expected ${value}`,
      );
    }
  }

  const noticePackageIds = [...notices.matchAll(/^Package-ID: (.+)$/gm)].map(
    (match) => match[1],
  );
  const noticeDocumentIds = [...notices.matchAll(/^License-Document: (.+)$/gm)].map(
    (match) => match[1],
  );
  const noticePackageSet = new Set(noticePackageIds);
  const noticeDocumentSet = new Set(noticeDocumentIds);
  const missingNoticePackages = difference(inventoryIds, noticePackageSet);
  const extraNoticePackages = difference(noticePackageSet, inventoryIds);
  if (missingNoticePackages.length > 0) {
    errors.push(`Notices omit inventory packages: ${missingNoticePackages.join(", ")}`);
  }
  if (extraNoticePackages.length > 0) {
    errors.push(`Notices contain unknown packages: ${extraNoticePackages.join(", ")}`);
  }
  if (duplicateValues(noticePackageIds).length > 0) {
    errors.push("Notices contain duplicate Package-ID entries");
  }

  const missingNoticeDocuments = difference(documentIds, noticeDocumentSet);
  const extraNoticeDocuments = difference(noticeDocumentSet, documentIds);
  if (missingNoticeDocuments.length > 0) {
    errors.push(`Notices omit license documents: ${missingNoticeDocuments.join(", ")}`);
  }
  if (extraNoticeDocuments.length > 0) {
    errors.push(`Notices contain unknown license documents: ${extraNoticeDocuments.join(", ")}`);
  }
  if (duplicateValues(noticeDocumentIds).length > 0) {
    errors.push("Notices contain duplicate License-Document entries");
  }
  const hashedDocumentIds = new Set();
  for (const match of notices.matchAll(
    /^License-Document: (.+)\nApplies-to:.*\nSource-files:.*\n\n([\s\S]*?)\n\nLicense-Document-End: \1$/gm,
  )) {
    const [, documentId, documentText] = match;
    hashedDocumentIds.add(documentId);
    if (`sha256:${sha256(documentText)}` !== documentId) {
      errors.push(`License document hash does not match its text: ${documentId}`);
    }
  }
  const unverifiedNoticeDocuments = difference(documentIds, hashedDocumentIds);
  if (unverifiedNoticeDocuments.length > 0) {
    errors.push(
      `Notices contain unparseable license documents: ${unverifiedNoticeDocuments.join(", ")}`,
    );
  }

  if (!(tauriConfig.bundle?.resources ?? []).includes("../THIRD-PARTY-NOTICES")) {
    errors.push("Tauri bundle resources do not include ../THIRD-PARTY-NOTICES");
  }

  return errors;
}

export function verifyRepository() {
  const inventoryText = readFileSync(inventoryPath, "utf8");
  const inventory = JSON.parse(inventoryText);
  const notices = readFileSync(noticesPath, "utf8");
  const expected = buildRepositoryOutputs();
  const errors = collectVerificationErrors({
    inventory,
    packageLock: readJson(packageLockPath),
    cargoLock: readFileSync(cargoLockPath, "utf8"),
    rootPackage: readJson(rootPackagePath),
    notices,
    tauriConfig: readJson(tauriConfigPath),
    cargoOverrides: readJson(cargoOverridesPath),
  });

  errors.push(...compareGeneratedOutputs({ inventoryText, notices }, expected));

  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join("\n"));
  }

  return inventory.summary;
}

function main() {
  const command = process.argv[2];
  if (command === "generate") {
    const summary = generateRepositoryInventory();
    console.log(
      `Generated notices for ${summary.npmPackages} npm and ${summary.cargoPackages} Rust packages ` +
        `(${summary.reviewRequired} require human follow-up).`,
    );
    return;
  }
  if (command === "check") {
    const summary = verifyRepository();
    console.log(
      `Verified notices for ${summary.npmPackages} npm and ${summary.cargoPackages} Rust packages ` +
        `(${summary.reviewRequired} require human follow-up).`,
    );
    return;
  }

  throw new Error("Usage: node scripts/third-party-notices.mjs <generate|check>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
