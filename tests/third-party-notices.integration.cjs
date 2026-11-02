const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");

async function noticesModule() {
  return import(pathToFileURL(path.join(repoRoot, "scripts/third-party-notices.mjs")));
}

test("regenerate-and-compare rejects edits to generated fields and mappings", async () => {
  const { buildRepositoryOutputs, compareGeneratedOutputs } = await noticesModule();
  const expected = buildRepositoryOutputs();
  const changedInventory = expected.inventoryText.replace(
    '"declaredLicense": "MIT"',
    '"declaredLicense": "GPL-3.0"',
  );
  const changedNotices = expected.notices
    .replace("License: MIT\n", "License: GPL-3.0\n")
    .replace("Applies-to:", "Applies-to: corrupted,")
    .replace("Source-files:", "Source-files: corrupted,");

  assert.deepEqual(
    compareGeneratedOutputs(
      { inventoryText: changedInventory, notices: changedNotices },
      expected,
    ),
    [
      "third-party-software.json is stale or modified; run npm run licenses:generate",
      "THIRD-PARTY-NOTICES is stale or modified; run npm run licenses:generate",
    ],
  );
});

test("runtime exceptions are classified and resolved conservatively", async () => {
  const { buildRepositoryOutputs } = await noticesModule();
  const { inventory } = buildRepositoryOutputs();
  function cargoPackage(name) {
    const entries = inventory.packages.filter((entry) => entry.kind === "cargo" && entry.name === name);
    assert.equal(entries.length, 1, `expected one locked ${name} version`);
    return entries[0];
  }

  assert.equal(cargoPackage("brotli").reviewRequired, false);
  assert.equal(cargoPackage("brotli").documentRefs.length, 2);
  assert.equal(cargoPackage("objc2").selectedLicense, "MIT");
  assert.equal(
    cargoPackage("objc2").disposition,
    "reviewed-standard-license-override",
  );
  assert.equal(cargoPackage("proc-macro-error").distributionClass, "inventory-only");
  assert.equal(
    cargoPackage("option-ext").sourceAvailability.sha256,
    "04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d",
  );
  const dompurify = inventory.packages.find((entry) => entry.kind === "npm" && entry.name === "dompurify");
  assert.ok(dompurify, "DOMPurify must be included in the notice inventory");
  assert.equal(dompurify.selectedLicense, "Apache-2.0");
});
