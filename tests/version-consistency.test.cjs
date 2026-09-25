const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function matchOrThrow(relativePath, text, pattern) {
  const match = pattern.exec(text);
  assert.ok(match, `${relativePath}: expected to find a version matching ${pattern}`);
  return match[1];
}

// Keep every active release-version declaration synchronized. The retired
// Arch package no longer participates because AppImage distribution is paused.
const declaredVersions = {
  "package.json": readJson("package.json").version,
  "package-lock.json (root)": readJson("package-lock.json").version,
  "package-lock.json (packages)": readJson("package-lock.json").packages[""].version,
  "src-tauri/tauri.conf.json": readJson("src-tauri/tauri.conf.json").version,
  "src-tauri/Cargo.toml": matchOrThrow(
    "src-tauri/Cargo.toml",
    readText("src-tauri/Cargo.toml"),
    /^version = "([^"]+)"$/m,
  ),
  "src-tauri/Cargo.lock": matchOrThrow(
    "src-tauri/Cargo.lock",
    readText("src-tauri/Cargo.lock"),
    /\[\[package\]\]\nname = "bindars"\nversion = "([^"]+)"/,
  ),
};

test("every version declaration matches package.json", () => {
  const reference = declaredVersions["package.json"];
  assert.match(reference, /^\d+\.\d+\.\d+/, "package.json version must be semver");
  const mismatches = Object.entries(declaredVersions)
    .filter(([, version]) => version !== reference)
    .map(([source, version]) => `${source} declares ${version}`);
  assert.deepEqual(
    mismatches,
    [],
    `all release version declarations must match package.json (${reference})`,
  );
});

test(
  "a release tag matches the declared version",
  { skip: process.env.GITHUB_REF_TYPE !== "tag" },
  () => {
    const version = declaredVersions["package.json"];
    const tag = process.env.GITHUB_REF_NAME;
    assert.ok(
      tag === `v${version}` || tag?.startsWith(`v${version}-`),
      `release tag ${tag ?? "missing"} must match v${version}`,
    );
  },
);
