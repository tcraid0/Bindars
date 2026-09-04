const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");

async function noticesModule() {
  return import(pathToFileURL(path.join(repoRoot, "scripts/third-party-notices.mjs")));
}

function repositoryInputs() {
  return {
    inventory: JSON.parse(
      fs.readFileSync(path.join(repoRoot, "third-party-software.json"), "utf8"),
    ),
    packageLock: JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"),
    ),
    cargoLock: fs.readFileSync(path.join(repoRoot, "src-tauri/Cargo.lock"), "utf8"),
    rootPackage: JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ),
    notices: fs.readFileSync(path.join(repoRoot, "THIRD-PARTY-NOTICES"), "utf8"),
    tauriConfig: JSON.parse(
      fs.readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
    ),
    cargoOverrides: JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "scripts/license-overrides/cargo-upstream.json"),
        "utf8",
      ),
    ),
  };
}

test("the checked-in notices cover both lockfiles and the packaged resource", async () => {
  const { collectVerificationErrors } = await noticesModule();
  assert.deepEqual(collectVerificationErrors(repositoryInputs()), []);
});

test("the notices embed the verbatim LGPL-2.1 text", () => {
  const license = fs.readFileSync(
    path.join(repoRoot, "scripts/license-overrides/LGPL-2.1.txt"),
    "utf8",
  );
  const notices = fs.readFileSync(path.join(repoRoot, "THIRD-PARTY-NOTICES"), "utf8");

  assert.ok(notices.includes(license));
});

test("the coverage check rejects a newly unreviewed locked package", async () => {
  const { collectVerificationErrors } = await noticesModule();
  const inputs = repositoryInputs();
  const removed = inputs.inventory.packages.find(
    (packageEntry) => packageEntry.kind === "npm",
  );
  inputs.inventory = {
    ...inputs.inventory,
    packages: inputs.inventory.packages.filter(
      (packageEntry) => packageEntry.id !== removed.id,
    ),
  };

  const errors = collectVerificationErrors(inputs);
  assert.ok(
    errors.some(
      (error) =>
        error.startsWith("Inventory is missing locked packages:") &&
        error.includes(removed.id),
    ),
  );
});

test("the coverage check rejects removal from the packaged notices", async () => {
  const { collectVerificationErrors } = await noticesModule();
  const inputs = repositoryInputs();
  const packageId = inputs.inventory.packages[0].id;
  inputs.notices = inputs.notices.replace(`Package-ID: ${packageId}\n`, "");

  assert.ok(
    collectVerificationErrors(inputs).some(
      (error) =>
        error.startsWith("Notices omit inventory packages:") &&
        error.includes(packageId),
    ),
  );
});

test("the coverage check rejects stale upstream license evidence", async () => {
  const { collectVerificationErrors } = await noticesModule();
  const inputs = repositoryInputs();
  const [documentKey] = Object.keys(inputs.cargoOverrides.documents);
  inputs.cargoOverrides.documents[documentKey].text += "\ntampered";

  assert.ok(
    collectVerificationErrors(inputs).some(
      (error) => error.includes("omits its override document"),
    ),
  );
});

test("semantic license checks reject pointer files and incomplete AND evidence", async () => {
  const { licenseEvidenceSatisfies } = await noticesModule();
  const pointer = `Copyright 2012-2016 The Rust Project Developers.

Licensed under the Apache License, Version 2.0 or the MIT license, at your option.`;
  const mit = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal in the
Software without restriction.

The above copyright notice and this permission notice shall be included in all copies.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`;
  const bsd = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met.

Neither the name of the copyright holder nor the names of its contributors may be used
to endorse or promote products derived from this software.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS".`;

  assert.equal(licenseEvidenceSatisfies("MIT OR Apache-2.0", [pointer]), false);
  assert.equal(licenseEvidenceSatisfies("BSD-3-Clause AND MIT", [mit]), false);
  assert.equal(licenseEvidenceSatisfies("BSD-3-Clause AND MIT", [mit, bsd]), true);
});

test("the npm inventory includes build tools whose generated code ships", async () => {
  const { npmLockPackages } = await noticesModule();
  const packages = npmLockPackages({
    packages: {
      "": { version: "1.0.0" },
      "node_modules/runtime": { version: "1.0.0" },
      "node_modules/test-only": { version: "1.0.0", dev: true },
      "node_modules/tailwindcss": { version: "4.1.18", dev: true },
      "node_modules/vite": { version: "7.3.6", dev: true },
    },
  });

  assert.deepEqual(
    packages.map(({ id, distributionClass }) => ({ id, distributionClass })),
    [
      { id: "npm:runtime@1.0.0", distributionClass: "runtime-dependency" },
      {
        id: "npm:tailwindcss@4.1.18",
        distributionClass: "build-output-contributor",
      },
      { id: "npm:vite@7.3.6", distributionClass: "build-output-contributor" },
    ],
  );
});
