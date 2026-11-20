const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const repo = path.resolve(__dirname, "..");
const cli = path.join(repo, "node_modules/@tauri-apps/cli/tauri.js");
const version = "1.8.0";
const tag = "v" + version;
const asset = "Bindars_" + version + "_aarch64.app.tar.gz";
const contents = "Fixture archive bytes\n";
const password = "throwaway-update-test";
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "bindars-update-test-"));
const key = path.join(fixtures, "test.key");
let config;
let otherPublicKey;
let writeUpdateManifest;
let signed;
let signedWithoutVersion;
let signedForOtherVersion;

function signer(...args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("TAURI_SIGNING_")) delete env[name];
  }
  execFileSync(process.execPath, [cli, "signer", ...args], { cwd: repo, env });
}

function signFixture(...args) {
  const directory = fs.mkdtempSync(path.join(fixtures, "sign-"));
  const archive = path.join(directory, asset);
  fs.writeFileSync(archive, contents);
  signer("sign", "-f", key, "-p", password, ...args, archive);
  return fs.readFileSync(archive + ".sig", "utf8");
}

before(async () => {
  ({ writeUpdateManifest } = await import("../scripts/update-manifest.mjs"));
  signer("generate", "--ci", "-p", password, "-w", key);
  const pubkey = fs.readFileSync(key + ".pub", "utf8").trim();
  config = { version, plugins: { updater: { pubkey } } };
  const otherKey = path.join(fixtures, "other.key");
  signer("generate", "--ci", "-p", password, "-w", otherKey);
  otherPublicKey = fs.readFileSync(otherKey + ".pub", "utf8").trim();
  signed = signFixture("--app-version", version);
  signedWithoutVersion = signFixture();
  signedForOtherVersion = signFixture("--app-version", "1.7.1");
});

after(() => fs.rmSync(fixtures, { recursive: true, force: true }));

function fixture(t, signature = signed) {
  const folder = fs.mkdtempSync(path.join(fixtures, "manifest-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const archivePath = path.join(folder, asset);
  fs.writeFileSync(archivePath, contents);
  fs.writeFileSync(archivePath + ".sig", signature);
  return {
    output: path.join(folder, "latest.json"),
    options: { config, version, tag, archivePath },
  };
}

test("writes a signed Apple Silicon update using the exact release URL", (t) => {
  const { output, options } = fixture(t);
  assert.equal(writeUpdateManifest(options), output);
  const manifest = JSON.parse(fs.readFileSync(output, "utf8"));
  const updaterSource = fs.readFileSync(path.join(repo, "src-tauri/src/updates.rs"), "utf8");
  const appPrefix = /const DOWNLOAD_PREFIX: &str = "([^"]+)";/u.exec(updaterSource)[1];
  assert.equal(manifest.version, version);
  assert.equal(new Date(manifest.pub_date).toISOString(), manifest.pub_date);
  assert.deepEqual(manifest.platforms, {
    "darwin-aarch64": {
      signature: signed.trim(),
      url: appPrefix + tag + "/" + asset,
    },
  });
  assert.throws(() => writeUpdateManifest(options), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), manifest);
});

test("uses the actual pre-release tag in the URL", (t) => {
  const { output, options } = fixture(t);
  options.tag = tag + "-rehearsal.1";
  writeUpdateManifest(options);
  const manifest = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://github.com/tcraid0/Bindars/releases/download/v1.8.0-rehearsal.1/" + asset,
  );
});

test("refuses inconsistent version, tag, asset or absent platform files", (t) => {
  const { output, options } = fixture(t);
  assert.throws(() => writeUpdateManifest({ ...options, version: "1.7.1" }), /Version must match/);
  const malformedVersion = "1.8.0-01";
  assert.throws(
    () => writeUpdateManifest({ ...options, version: malformedVersion, config: { ...config, version: malformedVersion } }),
    /Expected a release version/,
  );
  for (const invalidTag of ["v1.7.1", "v1.8.01", tag + "/..", tag + "#fragment", tag + "-%2f", "https://example.com/" + tag]) {
    assert.throws(() => writeUpdateManifest({ ...options, tag: invalidTag }), /Expected the release tag/);
  }
  const wrongAsset = path.join(path.dirname(output), "other.app.tar.gz");
  assert.throws(() => writeUpdateManifest({ ...options, archivePath: wrongAsset }), /Expected update asset named/);
  fs.unlinkSync(options.archivePath);
  assert.throws(() => writeUpdateManifest(options), /ENOENT/);
  fs.writeFileSync(options.archivePath, contents);
  fs.unlinkSync(options.archivePath + ".sig");
  assert.throws(() => writeUpdateManifest(options), /ENOENT/);
  assert.equal(fs.existsSync(output), false);
});

test("refuses malformed, unbound or wrong-version signatures", (t) => {
  for (const [signature, error] of [
    ["invalid!", /Invalid Tauri signature/],
    [signedWithoutVersion, /missing an app version/],
    [signedForOtherVersion, /app version does not match/],
  ]) {
    const { output, options } = fixture(t, signature);
    assert.throws(() => writeUpdateManifest(options), error);
    assert.equal(fs.existsSync(output), false);
  }
});

test("refuses modified archive bytes, a modified trusted comment, and a different key", (t) => {
  const { output, options } = fixture(t);
  const wrongKeyConfig = { version, plugins: { updater: { pubkey: otherPublicKey } } };
  assert.throws(() => writeUpdateManifest({ ...options, config: wrongKeyConfig }), /key does not match/);
  fs.appendFileSync(options.archivePath, "Changed bytes");
  assert.throws(() => writeUpdateManifest(options), /does not match the update archive/);
  fs.writeFileSync(options.archivePath, contents);
  const text = Buffer.from(signed.trim(), "base64").toString("utf8");
  assert.match(text, /\tversion:1\.8\.0/);
  fs.writeFileSync(options.archivePath + ".sig", Buffer.from(text.replace("version:1.8.0", "version:1.8.1")).toString("base64"));
  assert.throws(() => writeUpdateManifest(options), /Invalid minisign trusted comment signature/);
  assert.equal(fs.existsSync(output), false);
});
