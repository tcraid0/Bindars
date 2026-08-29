const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const loadValidator = () => import("../scripts/validate-macos-app.mjs");

function fixtureConfig(macOS = {}) {
  return {
    productName: "Bindars",
    version: "1.4.2",
    identifier: "dev.bindars.app",
    bundle: {
      macOS,
      icon: ["icons/icon.icns"],
      resources: ["../LICENSE"],
      fileAssociations: [
        {
          ext: ["md", ".markdown"],
          contentTypes: ["net.daringfireball.markdown"],
        },
      ],
    },
  };
}

function fixturePlist(minimumSystemVersion = "10.13") {
  return {
    CFBundlePackageType: "APPL",
    CFBundleName: "Bindars",
    CFBundleIdentifier: "dev.bindars.app",
    CFBundleShortVersionString: "1.4.2",
    CFBundleVersion: "1.4.2",
    LSMinimumSystemVersion: minimumSystemVersion,
    CFBundleDocumentTypes: [
      {
        CFBundleTypeExtensions: ["markdown", "md"],
        LSItemContentTypes: ["net.daringfireball.markdown"],
        CFBundleTypeName: "md",
        CFBundleTypeRole: "Editor",
        LSHandlerRank: "Default",
      },
    ],
  };
}

test("bundle validation derives metadata from Tauri config", async () => {
  const { validatePlistMetadata } = await loadValidator();
  const metadata = validatePlistMetadata(fixturePlist(), fixtureConfig());

  assert.equal(metadata.identifier, "dev.bindars.app");
  assert.equal(metadata.minimumSystemVersion, "10.13");
  assert.deepEqual(metadata.documentTypes, [
    {
      extensions: ["markdown", "md"],
      contentTypes: ["net.daringfireball.markdown"],
    },
  ]);
});

test("inherited minimum system version is inspected without freezing its value", async () => {
  const { validatePlistMetadata } = await loadValidator();

  assert.doesNotThrow(() => validatePlistMetadata(fixturePlist("15.2"), fixtureConfig()));
});

test("an explicit minimum system version must match the generated plist", async () => {
  const { validatePlistMetadata } = await loadValidator();

  assert.throws(
    () => validatePlistMetadata(
      fixturePlist("10.13"),
      fixtureConfig({ minimumSystemVersion: "13.0" }),
    ),
    /LSMinimumSystemVersion mismatch/,
  );
});

test("an explicit null minimum requires the generated plist key to be absent", async () => {
  const { validatePlistMetadata } = await loadValidator();
  const plist = fixturePlist();
  delete plist.LSMinimumSystemVersion;

  const metadata = validatePlistMetadata(plist, fixtureConfig({ minimumSystemVersion: null }));
  assert.equal(metadata.minimumSystemVersion, null);
  assert.throws(
    () => validatePlistMetadata(
      fixturePlist(),
      fixtureConfig({ minimumSystemVersion: null }),
    ),
    /must be absent/,
  );
});

test("minimum system version must be dotted numeric metadata", async () => {
  const { validatePlistMetadata } = await loadValidator();

  assert.throws(
    () => validatePlistMetadata(fixturePlist("future"), fixtureConfig()),
    /not a dotted numeric version/,
  );
});

test("document content types must match the generated plist", async () => {
  const { validatePlistMetadata } = await loadValidator();
  const plist = fixturePlist();
  delete plist.CFBundleDocumentTypes[0].LSItemContentTypes;

  assert.throws(
    () => validatePlistMetadata(plist, fixtureConfig()),
    /LSItemContentTypes/,
  );
});

test("extension-only document declarations do not invent macOS content types", async () => {
  const { validatePlistMetadata } = await loadValidator();
  const config = fixtureConfig();
  delete config.bundle.fileAssociations[0].contentTypes;
  const plist = fixturePlist();
  delete plist.CFBundleDocumentTypes[0].LSItemContentTypes;

  const metadata = validatePlistMetadata(plist, config);
  assert.deepEqual(metadata.documentTypes[0].contentTypes, []);
});

test("new UTI declaration forms require an explicit validator extension", async () => {
  const { validatePlistMetadata } = await loadValidator();
  const config = fixtureConfig();
  config.bundle.fileAssociations[0].exportedType = { conformsTo: ["public.text"] };

  assert.throws(
    () => validatePlistMetadata(fixturePlist(), config),
    /type declarations need explicit validator support/,
  );
});

test("unsigned bundle metadata rejects signing configuration", async () => {
  const { validatePlistMetadata } = await loadValidator();

  assert.throws(
    () => validatePlistMetadata(fixturePlist(), fixtureConfig({ signingIdentity: "-" })),
    /signingIdentity must be absent/,
  );
});

test("resource destinations mirror Tauri's relative-path layout", async () => {
  const { bundledResourcePath, expectedBundleResources } = await loadValidator();

  assert.equal(bundledResourcePath("../LICENSE"), "_up_/LICENSE");
  assert.deepEqual(expectedBundleResources(fixtureConfig()), ["_up_/LICENSE", "icon.icns"]);
  assert.throws(() => bundledResourcePath("/absolute/LICENSE"), /absolute resource is unsupported/);
  assert.throws(() => bundledResourcePath("docs/**/*.md"), /globbed resource/);
});

test("bundle tree inventory finds nested signing material", async (t) => {
  const { inventoryBundleTree } = await loadValidator();
  const root = await mkdtemp(path.join(os.tmpdir(), "bindars-macos-validator-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const resources = path.join(root, "Resources");
  const signature = path.join(resources, "Nested.app", "_CodeSignature");
  await mkdir(signature, { recursive: true });
  await writeFile(path.join(resources, "plain.txt"), "plain");
  await writeFile(path.join(signature, "CodeResources"), "signed");
  await writeFile(path.join(resources, "embedded.provisionprofile"), "profile");

  const inventory = await inventoryBundleTree(
    root,
    new Set(["_CodeSignature", "embedded.provisionprofile"]),
  );
  assert.deepEqual(
    inventory.regularFiles.sort(),
    [
      path.join(resources, "embedded.provisionprofile"),
      path.join(resources, "Nested.app", "_CodeSignature", "CodeResources"),
      path.join(resources, "plain.txt"),
    ].sort(),
  );
  assert.deepEqual(
    inventory.forbiddenEntries.sort(),
    [
      path.join(resources, "embedded.provisionprofile"),
      path.join(resources, "Nested.app", "_CodeSignature"),
    ].sort(),
  );
});

test("Mach-O inventory rejects unexpected native executables", async () => {
  const { validateMachOInventory } = await loadValidator();
  const executable = "/tmp/Bindars.app/Contents/MacOS/bindars";

  assert.doesNotThrow(() => validateMachOInventory([executable], executable));
  assert.throws(
    () => validateMachOInventory(
      [executable, "/tmp/Bindars.app/Contents/MacOS/signed-helper"],
      executable,
    ),
    /Unexpected additional Mach-O files need explicit validation/,
  );
  assert.throws(
    () => validateMachOInventory([], executable),
    /main executable is not Mach-O/,
  );
});

test("only absent or linker ad-hoc signatures are credential-free", async () => {
  const { classifyCredentialFreeSignature } = await loadValidator();
  const linkerSignature = [
    "CodeDirectory flags=0x20002(adhoc,linker-signed)",
    "Signature=adhoc",
    "TeamIdentifier=not set",
    "Sealed Resources=none",
  ].join("\n");

  assert.equal(classifyCredentialFreeSignature(linkerSignature), "linker ad hoc (no signing identity)");
  assert.equal(classifyCredentialFreeSignature("code object is not signed at all"), "none");
  assert.throws(
    () => classifyCredentialFreeSignature("Authority=Developer ID Application: Example\nTeamIdentifier=ABC123"),
    /signing authority/,
  );
  assert.throws(
    () => classifyCredentialFreeSignature("Authority=Unexpected\ncode object is not signed at all"),
    /signing authority/,
  );
});
