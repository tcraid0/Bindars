#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const TAURI_ROOT = path.join(PROJECT_ROOT, "src-tauri");
const TAURI_CONFIG_PATH = path.join(TAURI_ROOT, "tauri.conf.json");
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(message);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function sortedStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  return [...values].sort();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertStringArraysEqual(actual, expected, label) {
  const actualValues = sortedStrings(actual, label);
  const expectedValues = sortedStrings(expected, label);
  assertEqual(JSON.stringify(actualValues), JSON.stringify(expectedValues), label);
}

function normalizedExtensions(extensions, label) {
  return sortedStrings(extensions, label).map((extension) => extension.replace(/^\./, ""));
}

export function validatePlistMetadata(plist, config) {
  const identifier = requireNonEmptyString(config.identifier, "Tauri bundle identifier");
  const version = requireNonEmptyString(config.version, "Tauri app version");
  const macConfig = config.bundle?.macOS ?? {};
  const expectedBuildVersion = macConfig.bundleVersion ?? version;

  if (macConfig.signingIdentity != null) {
    fail("bundle.macOS.signingIdentity must be absent for the unsigned CI bundle");
  }
  if (macConfig.entitlements != null) {
    fail("bundle.macOS.entitlements must be absent for the unsigned CI bundle");
  }

  assertEqual(plist.CFBundlePackageType, "APPL", "CFBundlePackageType");
  assertEqual(
    plist.CFBundleName,
    macConfig.bundleName ?? config.productName,
    "CFBundleName",
  );
  assertEqual(plist.CFBundleIdentifier, identifier, "CFBundleIdentifier");
  assertEqual(plist.CFBundleShortVersionString, version, "CFBundleShortVersionString");
  assertEqual(plist.CFBundleVersion, expectedBuildVersion, "CFBundleVersion");

  const hasConfiguredMinimum = Object.hasOwn(macConfig, "minimumSystemVersion");
  let minimumSystemVersion = plist.LSMinimumSystemVersion;
  if (hasConfiguredMinimum && macConfig.minimumSystemVersion === null) {
    if (minimumSystemVersion != null) {
      fail("LSMinimumSystemVersion must be absent when minimumSystemVersion is null");
    }
    minimumSystemVersion = null;
  } else {
    minimumSystemVersion = requireNonEmptyString(
      minimumSystemVersion,
      "LSMinimumSystemVersion",
    );
    if (!/^\d+(?:\.\d+)+$/u.test(minimumSystemVersion)) {
      fail(`LSMinimumSystemVersion is not a dotted numeric version: ${minimumSystemVersion}`);
    }
  }
  if (hasConfiguredMinimum && macConfig.minimumSystemVersion !== null) {
    const configuredMinimum = requireNonEmptyString(
      macConfig.minimumSystemVersion,
      "bundle.macOS.minimumSystemVersion",
    );
    assertEqual(minimumSystemVersion, configuredMinimum, "LSMinimumSystemVersion");
  }

  const expectedAssociations = config.bundle?.fileAssociations ?? [];
  const actualAssociations = plist.CFBundleDocumentTypes ?? [];
  if (!Array.isArray(expectedAssociations) || !Array.isArray(actualAssociations)) {
    fail("File associations and CFBundleDocumentTypes must be arrays");
  }
  assertEqual(
    actualAssociations.length,
    expectedAssociations.length,
    "CFBundleDocumentTypes entry count",
  );

  const actualByExtensions = new Map();
  for (const association of actualAssociations) {
    const extensions = normalizedExtensions(
      association.CFBundleTypeExtensions,
      "CFBundleTypeExtensions",
    );
    const key = extensions.join("\0");
    if (actualByExtensions.has(key)) {
      fail(`Duplicate CFBundleDocumentTypes extensions: ${extensions.join(", ")}`);
    }
    actualByExtensions.set(key, association);
  }

  const documentTypes = expectedAssociations.map((association, index) => {
    if (association.exportedType != null) {
      fail("Exported macOS type declarations need explicit validator support before use");
    }
    if (!Array.isArray(association.ext) || association.ext.length === 0) {
      fail(`fileAssociations[${index}].ext must contain at least one extension`);
    }
    const extensions = normalizedExtensions(association.ext, `fileAssociations[${index}].ext`);
    const defaultName = association.ext[0].replace(/^\./, "");
    const key = extensions.join("\0");
    const actual = actualByExtensions.get(key);
    if (!actual) {
      fail(`Missing CFBundleDocumentTypes entry for: ${extensions.join(", ")}`);
    }

    const contentTypes = association.contentTypes ?? [];
    assertStringArraysEqual(
      actual.LSItemContentTypes ?? [],
      contentTypes,
      `LSItemContentTypes for ${extensions.join(", ")}`,
    );
    assertEqual(
      actual.CFBundleTypeName,
      association.name ?? defaultName,
      `CFBundleTypeName for ${extensions.join(", ")}`,
    );
    assertEqual(
      actual.CFBundleTypeRole,
      association.role ?? "Editor",
      `CFBundleTypeRole for ${extensions.join(", ")}`,
    );
    assertEqual(
      actual.LSHandlerRank,
      association.rank ?? "Default",
      `LSHandlerRank for ${extensions.join(", ")}`,
    );
    actualByExtensions.delete(key);

    return { extensions, contentTypes: sortedStrings(contentTypes, "contentTypes") };
  });
  if (plist.UTExportedTypeDeclarations != null || plist.UTImportedTypeDeclarations != null) {
    fail("Unexpected macOS UTI declarations need explicit validator support");
  }

  return {
    identifier,
    shortVersion: version,
    buildVersion: expectedBuildVersion,
    minimumSystemVersion,
    documentTypes,
  };
}

export function bundledResourcePath(resourcePath) {
  if (typeof resourcePath !== "string" || resourcePath.trim() === "") {
    fail("Bundle resource paths must be non-empty strings");
  }
  if (path.isAbsolute(resourcePath)) {
    fail(`Cannot derive a stable bundle destination for absolute resource: ${resourcePath}`);
  }
  if (/[*?\[\]{}]/u.test(resourcePath)) {
    fail(`Cannot structurally validate globbed resource without an explicit destination: ${resourcePath}`);
  }

  const normalized = path.posix.normalize(resourcePath.replaceAll("\\", "/"));
  return normalized
    .split("/")
    .filter((part) => part !== "." && part !== "")
    .map((part) => (part === ".." ? "_up_" : part))
    .join("/");
}

export function expectedBundleResources(config) {
  const resources = config.bundle?.resources ?? [];
  if (!Array.isArray(resources)) {
    fail("Bundle resource maps need explicit validator support before use");
  }

  const expected = resources.map(bundledResourcePath);
  for (const icon of config.bundle?.icon ?? []) {
    if (path.extname(icon).toLowerCase() === ".icns") {
      expected.push(path.basename(icon));
    }
  }
  return [...new Set(expected)].sort();
}

export function classifyCredentialFreeSignature(output) {
  const details = output.trim();
  if (/^Authority=/mu.test(details)) {
    fail("The app contains a certificate-backed signing authority");
  }

  const teamIdentifiers = [];
  for (const match of details.matchAll(/^TeamIdentifier=(.*)$/gmu)) {
    const identifier = match[1].trim();
    teamIdentifiers.push(identifier);
    if (identifier !== "not set") {
      fail(`The app contains signing team identifier ${JSON.stringify(identifier)}`);
    }
  }

  if (details === "" || /code object is not signed at all/iu.test(details)) {
    return "none";
  }
  if (/^Signature=adhoc$/mu.test(details) && /\blinker-signed\b/u.test(details)) {
    if (!teamIdentifiers.includes("not set")) {
      fail("The linker ad-hoc signature does not report TeamIdentifier=not set");
    }
    if (!/^Sealed Resources=none$/mu.test(details)) {
      fail("The linker ad-hoc signature unexpectedly seals bundle resources");
    }
    return "linker ad hoc (no signing identity)";
  }
  fail("Unable to prove that the app is free of signing credentials");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function commandResult(command, args) {
  return execFileAsync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function commandOutput(command, args) {
  const { stdout } = await commandResult(command, args);
  return stdout.trim();
}

async function codeSignatureDetails(appBundle) {
  try {
    const { stdout, stderr } = await commandResult(
      "codesign",
      ["--display", "--verbose=4", appBundle],
    );
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (/code object is not signed at all/iu.test(output)) return output;
    throw error;
  }
}

async function findNamedEntries(root, forbiddenNames) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (forbiddenNames.has(entry.name)) found.push(entryPath);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      found.push(...await findNamedEntries(entryPath, forbiddenNames));
    }
  }
  return found;
}

async function resolveBundlePath(argument, config) {
  if (argument) return path.resolve(argument);
  const productName = requireNonEmptyString(config.productName, "Tauri productName");
  return path.join(TAURI_ROOT, "target", "release", "bundle", "macos", `${productName}.app`);
}

async function validateBundle(appBundle, config) {
  if (process.platform !== "darwin") fail("macOS app validation must run on macOS");
  if (!existsSync(appBundle) || !(await stat(appBundle)).isDirectory()) {
    fail(`App bundle does not exist: ${appBundle}`);
  }

  const contents = path.join(appBundle, "Contents");
  const plistPath = path.join(contents, "Info.plist");
  await commandOutput("plutil", ["-lint", plistPath]);
  const plist = JSON.parse(await commandOutput("plutil", ["-convert", "json", "-o", "-", plistPath]));
  const metadata = validatePlistMetadata(plist, config);

  const executableName = requireNonEmptyString(plist.CFBundleExecutable, "CFBundleExecutable");
  if (path.basename(executableName) !== executableName || executableName === "." || executableName === "..") {
    fail(`CFBundleExecutable must be a safe filename: ${JSON.stringify(executableName)}`);
  }
  const executablePath = path.join(contents, "MacOS", executableName);
  const executableStat = existsSync(executablePath) ? await stat(executablePath) : null;
  if (!executableStat?.isFile()) {
    fail(`Bundle executable does not exist: ${executablePath}`);
  }
  if ((executableStat.mode & 0o111) === 0) fail(`Bundle executable is not executable: ${executablePath}`);

  const fileDescription = await commandOutput("file", [executablePath]);
  if (!/Mach-O/u.test(fileDescription)) fail(`Bundle executable is not Mach-O: ${fileDescription}`);

  const architectures = (await commandOutput("lipo", ["-archs", executablePath])).split(/\s+/u);
  const hostArchitecture = await commandOutput("uname", ["-m"]);
  if (!architectures.includes(hostArchitecture)) {
    fail(`Bundle architectures ${architectures.join(", ")} do not include host ${hostArchitecture}`);
  }

  const buildDetails = await commandOutput("xcrun", ["vtool", "-show-build", executablePath]);
  const executableMinimums = [...buildDetails.matchAll(/^\s*minos\s+(\S+)$/gmu)]
    .map((match) => match[1]);
  if (executableMinimums.length === 0) {
    fail("Mach-O executable has no readable macOS minimum-version load command");
  }

  const resourcesRoot = path.join(contents, "Resources");
  const resources = expectedBundleResources(config);
  for (const resource of resources) {
    const bundledPath = path.join(resourcesRoot, resource);
    if (!existsSync(bundledPath)) {
      fail(`Expected bundled resource is missing: Contents/Resources/${resource}`);
    }
  }

  const configuredResources = config.bundle?.resources ?? [];
  for (const configuredResource of configuredResources) {
    const sourcePath = path.resolve(TAURI_ROOT, configuredResource);
    const bundledPath = path.join(resourcesRoot, bundledResourcePath(configuredResource));
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      fail(`Bundle resource validation currently requires literal files: ${configuredResource}`);
    }
    if (!(await readFile(sourcePath)).equals(await readFile(bundledPath))) {
      fail(`Bundled resource differs from its source: ${configuredResource}`);
    }
  }

  const configuredIcons = (config.bundle?.icon ?? [])
    .filter((icon) => path.extname(icon).toLowerCase() === ".icns");
  if (configuredIcons.length !== 1) {
    fail(`Expected exactly one configured macOS icon, found ${configuredIcons.length}`);
  }
  const iconName = path.basename(configuredIcons[0]);
  assertEqual(plist.CFBundleIconFile, iconName, "CFBundleIconFile");
  const iconSource = path.resolve(TAURI_ROOT, configuredIcons[0]);
  const bundledIcon = path.join(resourcesRoot, iconName);
  if (!(await readFile(iconSource)).equals(await readFile(bundledIcon))) {
    fail("Bundled macOS icon differs from its configured source");
  }

  const forbiddenEntries = await findNamedEntries(
    contents,
    new Set(["_CodeSignature", "embedded.provisionprofile"]),
  );
  if (forbiddenEntries.length > 0) {
    fail(`Unsigned bundle contains signing material: ${forbiddenEntries.join(", ")}`);
  }
  const signature = classifyCredentialFreeSignature(await codeSignatureDetails(appBundle));

  console.log("Validated credential-free macOS app bundle");
  console.log(`  Bundle: ${appBundle}`);
  console.log(`  Executable: ${executableName}`);
  console.log(`  Architectures: ${architectures.join(", ")} (host: ${hostArchitecture})`);
  console.log(`  Identifier: ${metadata.identifier}`);
  console.log(`  Versions: short ${metadata.shortVersion}; build ${metadata.buildVersion}`);
  console.log(
    `  Minimum system versions: Info.plist ${metadata.minimumSystemVersion ?? "absent"}; Mach-O ${[...new Set(executableMinimums)].join(", ")}`,
  );
  for (const documentType of metadata.documentTypes) {
    const contentTypes = documentType.contentTypes.length > 0
      ? documentType.contentTypes.join(", ")
      : "none (extension-only)";
    console.log(`  Document type: ${documentType.extensions.join(", ")}; content types: ${contentTypes}`);
  }
  console.log(`  Resources: ${resources.join(", ")}`);
  console.log(`  Signing: ${signature}; no bundle signature or provisioning profile`);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || arguments_.includes("--help")) {
    console.log("Usage: node scripts/validate-macos-app.mjs [path/to/App.app]");
    process.exitCode = arguments_.includes("--help") ? 0 : 2;
    return;
  }

  const config = await readJson(TAURI_CONFIG_PATH);
  const macOSOverlays = [
    "tauri.macos.conf.json",
    "tauri.macos.conf.json5",
    "Tauri.macos.toml",
  ].filter((name) => existsSync(path.join(TAURI_ROOT, name)));
  if (macOSOverlays.length > 0) {
    fail(`macOS configuration overlays need explicit validator support: ${macOSOverlays.join(", ")}`);
  }
  const appBundle = await resolveBundlePath(arguments_[0], config);
  await validateBundle(appBundle, config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`macOS app validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
