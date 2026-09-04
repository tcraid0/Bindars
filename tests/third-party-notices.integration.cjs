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
  const byId = new Map(inventory.packages.map((entry) => [entry.id, entry]));

  assert.equal(byId.get("cargo:brotli@8.0.2").reviewRequired, false);
  assert.equal(byId.get("cargo:brotli@8.0.2").documentRefs.length, 2);
  assert.equal(byId.get("cargo:siphasher@1.0.2").selectedLicense, "MIT");
  assert.equal(
    byId.get("cargo:siphasher@1.0.2").disposition,
    "reviewed-standard-license-override",
  );
  assert.equal(byId.get("cargo:siphasher@0.3.11").distributionClass, "inventory-only");
  assert.equal(
    byId.get("cargo:option-ext@0.2.0").sourceAvailability.sha256,
    "04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d",
  );
  assert.equal(byId.get("npm:dompurify@3.4.14").selectedLicense, "Apache-2.0");
});
