import { execFile } from "node:child_process";
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readReleaseConfig, updateArchiveName } from "./update-manifest.mjs";

const exec = promisify(execFile);
const APP_NAME = "Bindars.app";
const TAR_METADATA_FLAGS = ["--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags"];

function compareContents(unpacked, mounted, relative = APP_NAME) {
  const actual = lstatSync(unpacked);
  const expected = lstatSync(mounted);
  const mismatch = () => new Error("Unpacked app differs from the DMG at " + relative);
  if (actual.isDirectory() && expected.isDirectory()) {
    const names = readdirSync(unpacked).sort();
    const expectedNames = readdirSync(mounted).sort();
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
      throw mismatch();
    }
    for (const name of names) {
      if (name.startsWith("._")) throw new Error("Unexpected AppleDouble file at " + path.join(relative, name));
      compareContents(path.join(unpacked, name), path.join(mounted, name), path.join(relative, name));
    }
  } else if (actual.isFile() && expected.isFile()) {
    // The updater strips the entry path's first component but not a tar hard link's target.
    if (actual.nlink !== 1) throw new Error("Unexpected hard link at " + relative);
    if ((actual.mode & 0o111) !== (expected.mode & 0o111) ||
        !readFileSync(unpacked).equals(readFileSync(mounted))) {
      throw mismatch();
    }
  } else if (actual.isSymbolicLink() && expected.isSymbolicLink()) {
    if (!readlinkSync(unpacked, { encoding: "buffer" }).equals(readlinkSync(mounted, { encoding: "buffer" }))) {
      throw mismatch();
    }
  } else {
    throw mismatch();
  }
}

async function verifyApp(app, config) {
  const plist = path.join(app, "Contents/Info.plist");
  const { stdout } = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== config.identifier || info.CFBundleShortVersionString !== config.version) {
    throw new Error("Unpacked app identifier or version differs from src-tauri/tauri.conf.json");
  }
  const executable = path.join(app, "Contents/MacOS", info.CFBundleExecutable);
  const { stdout: arch } = await exec("/usr/bin/lipo", ["-archs", executable]);
  if (arch.trim() !== "arm64") throw new Error("Expected an Apple Silicon-only Bindars executable");

  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
  await exec("/usr/bin/xcrun", ["stapler", "validate", app]);
  await exec("/usr/bin/syspolicy_check", ["distribution", app]);
  const { stderr: assessment } = await exec("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  if (!assessment.includes("source=Notarized Developer ID")) {
    throw new Error("Expected a Notarized Developer ID Gatekeeper assessment:\n" + assessment);
  }
  console.log("Unpacked app passed signature, staple and Gatekeeper checks.");
}

async function packUpdate(appPath, dmgPath, outputDir) {
  if (process.platform !== "darwin") throw new Error("Run this script on macOS");
  const config = readReleaseConfig();
  const app = realpathSync(appPath);
  const dmg = realpathSync(dmgPath);
  if (path.basename(app) !== APP_NAME || !lstatSync(app).isDirectory()) {
    throw new Error("Expected a final, stapled Bindars.app");
  }

  const archiveName = updateArchiveName(config.version);
  const output = path.resolve(outputDir, archiveName);
  const temp = mkdtempSync(path.join(path.dirname(output), ".macos-update-"));
  const archive = path.join(temp, archiveName);
  const mount = path.join(temp, "dmg");
  const unpacked = path.join(temp, "unpacked");
  let mounted = false;
  let interruption;
  const interrupt = () => { interruption = new Error("Update packaging interrupted"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await exec("/usr/bin/xcrun", ["stapler", "validate", app]);
    // The updater drops exactly one path component during installation.
    // Ustar and these flags keep macOS metadata out of the archive.
    await exec("/usr/bin/tar", [
      "-czf", archive, "--format", "ustar", ...TAR_METADATA_FLAGS, "-C", path.dirname(app), APP_NAME,
    ]);
    mkdirSync(unpacked);
    await exec("/usr/bin/tar", ["-xzf", archive, ...TAR_METADATA_FLAGS, "-C", unpacked]);
    const roots = readdirSync(unpacked);
    const unpackedApp = path.join(unpacked, APP_NAME);
    if (roots.length !== 1 || roots[0] !== APP_NAME || !lstatSync(unpackedApp).isDirectory()) {
      throw new Error("Archive must contain only " + APP_NAME + " at its root");
    }
    await verifyApp(unpackedApp, config);
    if (interruption) throw interruption;

    mkdirSync(mount);
    const unmountedDevice = lstatSync(mount).dev;
    try {
      await exec("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg]);
      if (lstatSync(mount).dev === unmountedDevice) {
        throw new Error("DMG did not mount at " + mount);
      }
      compareContents(unpackedApp, path.join(mount, APP_NAME));
      console.log("Unpacked app matches the app in the DMG byte for byte.");
    } finally {
      // Check the mount point even if hdiutil reported an error or was interrupted.
      mounted = lstatSync(mount).dev !== unmountedDevice;
      if (mounted) {
        try {
          await exec("/usr/bin/hdiutil", ["detach", mount]);
        } catch {
          await exec("/usr/bin/hdiutil", ["detach", "-force", mount]);
        }
        mounted = false;
      }
    }
    if (interruption) throw interruption;
    linkSync(archive, output);
    return output;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (!mounted) rmSync(temp, { recursive: true, force: true });
  }
}

try {
  const [app, dmg, outputDir, ...extra] = process.argv.slice(2);
  if (!app || !dmg || !outputDir || extra.length) {
    throw new Error("Usage: node scripts/pack-macos-update.mjs <stapled Bindars.app> <final DMG> <output directory>");
  }
  console.log(await packUpdate(app, dmg, outputDir));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
