const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parse } = require("yaml");

const projectRoot = path.resolve(__dirname, "..");
const workflowPath = path.join(projectRoot, ".github/workflows/release.yml");
const packageVerifierPath = path.join(projectRoot, "scripts/verify-deb-package.sh");

function namedStep(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing release step: ${name}`);
  return step;
}

test("release candidates are verified before tag-only publication", () => {
  const workflowText = fs.readFileSync(workflowPath, "utf8");
  const workflow = parse(workflowText);

  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.equal(workflow.jobs.package.needs, "verify");
  assert.equal(workflow.jobs.publish.needs, "package");
  assert.equal(workflow.jobs.publish.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(
    namedStep(workflow.jobs.package, "Build Debian package").run,
    "npm run tauri -- build --bundles deb --ci",
  );
  assert.equal(
    namedStep(workflow.jobs.package, "Inspect Debian package").run,
    "scripts/verify-deb-package.sh src-tauri/target/release/bundle/deb release-artifacts",
  );
  const installStep = namedStep(
    workflow.jobs.package,
    "Install and smoke-test Debian package",
  ).run;
  assert.match(installStep, /deb_path="\$\(realpath "\$deb_path"\)"/);
  assert.match(installStep, /sudo apt-get install -y "\$deb_path"/);
  assert.match(
    namedStep(workflow.jobs.publish, "Publish GitHub release").run,
    /gh release create/,
  );
  assert.doesNotMatch(workflowText, /tauri-action|--bundles appimage/i);
});

test("the Debian package verifier is executable Bash", () => {
  assert.notEqual(fs.statSync(packageVerifierPath).mode & 0o111, 0);
  execFileSync("bash", ["-n", packageVerifierPath]);
});
