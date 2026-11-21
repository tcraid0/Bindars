import { createHash, createPublicKey, verify } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RELEASES = "https://github.com/tcraid0/Bindars/releases";
const CONFIG_PATH = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const TRUSTED_COMMENT_PREFIX = "trusted comment: ";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function readReleaseConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function updateArchiveName(version) {
  // Keep the filename safe for GitHub release assets and the tag safe as a URL segment.
  const releaseVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*))?$/u.exec(version);
  if (!releaseVersion || releaseVersion[1]?.split(".").some((part) => /^0\d+$/u.test(part))) {
    throw new Error("Expected a release version such as 1.8.0 or 1.8.0-rc.1");
  }
  return "Bindars_" + version + "_aarch64.app.tar.gz";
}

function decodeBase64(value, label, length) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Missing " + label);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length)) {
    throw new Error("Invalid " + label);
  }
  return bytes;
}

function verifyUpdateSignature(archive, signature, publicKey, version) {
  // Tauri wraps the UTF-8 minisign files in base64. Minisign stores the
  // two-byte algorithm and eight-byte key ID before the key or signature.
  const [, keyLine] = utf8.decode(decodeBase64(publicKey, "Tauri public key")).split(/\r?\n/u);
  const [, signatureLine, comment, globalLine] =
    utf8.decode(decodeBase64(signature, "Tauri signature")).split(/\r?\n/u);
  const keyBytes = decodeBase64(keyLine, "minisign public key", 42);
  const signatureBytes = decodeBase64(signatureLine, "minisign signature", 74);
  const globalSignature = decodeBase64(globalLine, "minisign comment signature", 64);
  const keyAlgorithm = keyBytes.subarray(0, 2).toString("latin1");
  const algorithm = signatureBytes.subarray(0, 2).toString("latin1");
  if (!["Ed", "ED"].includes(keyAlgorithm) || !["Ed", "ED"].includes(algorithm)) {
    throw new Error("Unsupported minisign algorithm");
  }
  if (!keyBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10))) {
    throw new Error("Signature key does not match the configured Tauri public key");
  }
  if (!comment?.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error("Missing minisign trusted comment");
  }

  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const data = algorithm === "ED" ? createHash("blake2b512").update(archive).digest() : archive;
  const fileSignature = signatureBytes.subarray(10);
  if (!verify(null, data, key, fileSignature)) {
    throw new Error("Signature does not match the update archive");
  }

  // The second signature authenticates the file signature and the comment.
  const trustedComment = comment.slice(TRUSTED_COMMENT_PREFIX.length);
  const signedComment = Buffer.concat([fileSignature, Buffer.from(trustedComment)]);
  if (!verify(null, signedComment, key, globalSignature)) {
    throw new Error("Invalid minisign trusted comment signature");
  }
  const signedVersion = trustedComment.split("\t").find((field) => field.startsWith("version:"));
  if (!signedVersion) {
    throw new Error("Signature is missing an app version. Sign with --app-version.");
  }
  // Match the updater's first version field and its optional leading v.
  if (signedVersion.slice("version:".length).replace(/^v+/u, "") !== version) {
    throw new Error("Signature app version does not match " + version);
  }
}

export function writeUpdateManifest({ config, version, tag, archivePath }) {
  if (version !== config.version) {
    throw new Error("Version must match src-tauri/tauri.conf.json (" + config.version + ")");
  }
  const archiveName = updateArchiveName(version);
  const versionTag = "v" + version;
  // The release workflow also permits tags like v1.8.0-rehearsal.1 for pre-releases.
  const suffix = tag.slice(versionTag.length);
  if (!tag.startsWith(versionTag) || (suffix && !/^-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/u.test(suffix))) {
    throw new Error("Expected the release tag " + versionTag + " or that tag with a pre-release suffix");
  }
  if (path.basename(archivePath) !== archiveName) {
    throw new Error("Expected update asset named " + archiveName);
  }
  const signature = readFileSync(archivePath + ".sig", "utf8").trim();
  verifyUpdateSignature(readFileSync(archivePath), signature, config.plugins?.updater?.pubkey, version);

  const manifest = {
    version,
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": {
        signature,
        url: RELEASES + "/download/" + tag + "/" + archiveName,
      },
    },
  };
  const directory = path.dirname(path.resolve(archivePath));
  const output = path.join(directory, "latest.json");
  const temp = mkdtempSync(path.join(directory, ".update-manifest-"));
  try {
    const candidate = path.join(temp, "latest.json");
    writeFileSync(candidate, JSON.stringify(manifest, null, 2) + "\n");
    linkSync(candidate, output);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [version, tag, archivePath, ...extra] = process.argv.slice(2);
    if (!version || !tag || !archivePath || extra.length) {
      throw new Error("Usage: node scripts/update-manifest.mjs <version> <tag> <archive>");
    }
    console.log(writeUpdateManifest({ config: readReleaseConfig(), version, tag, archivePath }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
