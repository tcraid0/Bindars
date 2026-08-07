import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildFileIdentityManifest,
} from "../scripts/verify-document-performance.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("source identity manifests are sorted, deduplicated, and content-addressed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bindars-source-identity-"));
  try {
    await writeFile(path.join(directory, "zeta.txt"), "zeta\n", "utf8");
    await writeFile(path.join(directory, "alpha.txt"), "α", "utf8");
    await symlink("alpha.txt", path.join(directory, "alpha-link"));

    const manifest = await buildFileIdentityManifest(directory, [
      "zeta.txt",
      "alpha-link",
      "alpha.txt",
      "zeta.txt",
    ]);

    assert.deepEqual(manifest, [
      {
        path: "alpha-link",
        type: "symlink",
        bytes: Buffer.byteLength("alpha.txt"),
        sha256: sha256("alpha.txt"),
      },
      {
        path: "alpha.txt",
        type: "file",
        bytes: Buffer.byteLength("α"),
        sha256: sha256("α"),
      },
      {
        path: "zeta.txt",
        type: "file",
        bytes: Buffer.byteLength("zeta\n"),
        sha256: sha256("zeta\n"),
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source identity rejects paths outside its root", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bindars-source-identity-"));
  try {
    await assert.rejects(
      buildFileIdentityManifest(directory, ["../outside.txt"]),
      /escapes the source root/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
