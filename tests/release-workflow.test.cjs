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
  const cspStep = namedStep(workflow.jobs.package, "Verify packaged WebKit styles");
  assert.match(cspStep.run, /scripts\/verify-webkit-csp-styles\.py/);
  assert.match(cspStep.run, /xvfb-run/);
  assert.ok(workflow.jobs.package.steps.indexOf(cspStep)
    > workflow.jobs.package.steps.indexOf(namedStep(workflow.jobs.package, "Build Debian package")));
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

test("CI and release verification run Rust integration tests as well as library tests", () => {
  const ci = parse(fs.readFileSync(path.join(projectRoot, ".github/workflows/ci.yml"), "utf8"));
  const release = parse(fs.readFileSync(workflowPath, "utf8"));
  for (const job of [ci.jobs["rust-tests"], ci.jobs.macos, release.jobs.verify]) {
    const step = namedStep(job, "Run Rust tests");
    assert.equal(step["working-directory"], "src-tauri");
    assert.equal(step.run, "cargo test --locked", "include src-tauri/tests in verification");
  }
});

test("security and release gates audit build and test dependencies", () => {
  const audit = parse(fs.readFileSync(path.join(projectRoot, ".github/workflows/audit.yml"), "utf8"));
  const release = parse(fs.readFileSync(workflowPath, "utf8"));
  for (const job of [audit.jobs["npm-audit"], release.jobs.verify]) {
    assert.equal(namedStep(job, "Audit development dependencies").run,
      "node scripts/audit-dev-dependencies.mjs");
    assert.ok(job.steps.some((step) => step.run === "npm audit --omit=dev --audit-level=moderate"),
      "shipped dependencies are audited without exceptions");
  }
  for (const event of ["push", "pull_request"]) {
    for (const file of ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", ".github/workflows/audit.yml", "scripts/audit-dev-dependencies.mjs"]) {
      assert.ok(audit.on[event].paths.includes(file), `${event} must audit changes to ${file}`);
    }
  }
});

test("the development audit accepts only listed advisories and rejects stale exceptions", async () => {
  const { evaluateAudit } = await import("../scripts/audit-dev-dependencies.mjs");
  const advisory = (id, name, severity) => ({
    source: 1, name, title: `${name} advisory`, severity, url: `https://github.com/advisories/${id}`,
  });
  const report = (...advisories) => ({
    vulnerabilities: Object.fromEntries([
      ...advisories.map((item) => [item.name, { via: [item] }]),
      ["a-parent", { via: advisories.map((item) => item.name) }],
    ]),
  });
  const accepted = { "GHSA-aaaa-aaaa-aaaa": "globber" };
  const known = advisory("GHSA-aaaa-aaaa-aaaa", "globber", "high");

  assert.deepEqual(evaluateAudit(report(known), accepted).unaccepted, []);
  assert.deepEqual(evaluateAudit(report(known), accepted).stale, []);

  const other = evaluateAudit(report(known, advisory("GHSA-bbbb-bbbb-bbbb", "parser", "moderate")), accepted);
  assert.deepEqual(other.unaccepted.map((item) => item.id), ["GHSA-bbbb-bbbb-bbbb"]);

  const renamed = evaluateAudit(report(advisory("GHSA-aaaa-aaaa-aaaa", "another-package", "high")), accepted);
  assert.deepEqual(renamed.unaccepted.map((item) => item.name), ["another-package"]);

  assert.deepEqual(evaluateAudit(report(advisory("GHSA-cccc-cccc-cccc", "tool", "low")), {}).unaccepted, []);
  assert.deepEqual(evaluateAudit(report(), accepted).stale, ["GHSA-aaaa-aaaa-aaaa"]);
});
