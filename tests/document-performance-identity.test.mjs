import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertOutputOutsideRepository,
  buildFileIdentityManifest,
  sourceTreeIdentity,
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

test("machine-specific results cannot be written inside the repository", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bindars-private-output-"));
  const repository = path.join(directory, "repository");
  const outside = path.join(directory, "private-results");
  const repositoryAlias = path.join(directory, "repository-alias");
  try {
    await mkdir(repository);
    await mkdir(outside);
    await symlink(repository, repositoryAlias);

    await assert.rejects(
      assertOutputOutsideRepository(path.join(repository, "results.json"), repository),
      /Refusing to write machine-specific performance results inside the repository/,
    );
    await assert.rejects(
      assertOutputOutsideRepository(path.join(repositoryAlias, "results.json"), repository),
      /Refusing to write machine-specific performance results inside the repository/,
    );
    await assert.doesNotReject(
      assertOutputOutsideRepository(path.join(outside, "results.json"), repository),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source-tree identity covers tracked changes and nonignored untracked files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bindars-source-tree-identity-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  try {
    git("init", "--initial-branch=measurement-test");
    await writeFile(path.join(directory, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(path.join(directory, "tracked.txt"), "before\n", "utf8");
    git("add", ".gitignore", "tracked.txt");
    git(
      "-c",
      "user.name=Bindars Test",
      "-c",
      "user.email=bindars-test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );

    await writeFile(path.join(directory, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(directory, "untracked.txt"), "visible\n", "utf8");
    await writeFile(path.join(directory, "ignored.txt"), "private\n", "utf8");

    const identity = await sourceTreeIdentity(directory);

    assert.equal(identity.branch, "measurement-test");
    assert.match(identity.head, /^[0-9a-f]{40}$/);
    assert.match(identity.trackedDiffAgainstHeadSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      identity.nonIgnoredUntrackedFiles.map((entry) => entry.path),
      ["untracked.txt"],
    );
    assert.match(identity.nonIgnoredUntrackedFilesManifestSha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
