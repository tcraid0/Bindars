// Audits build and test dependencies (`npm audit --include=dev`) and fails on
// any advisory of moderate severity or higher that is not accepted below.
//
// Shipped dependencies have no exceptions: they are audited separately with
// `npm audit --omit=dev --audit-level=moderate`, which also fails if a package
// accepted here ever becomes part of the app.
//
// An accepted advisory that is no longer reported also fails, so an exception
// cannot outlive its reason.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Each entry maps an advisory ID to its package name, with a comment giving the
// reason and the review date. None are accepted at the moment.
export const ACCEPTED_ADVISORIES = {};

const BLOCKING = new Set(["moderate", "high", "critical"]);

export function evaluateAudit(report, accepted = ACCEPTED_ADVISORIES) {
  const reported = new Map();
  for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      // Strings name a parent package; the advisory itself is listed on that parent.
      if (typeof via === "string" || !BLOCKING.has(via.severity)) continue;
      const id = String(via.url ?? "").split("/").pop() || `npm-${via.source}`;
      reported.set(id, { id, name: via.name, severity: via.severity, title: via.title });
    }
  }
  const unaccepted = [...reported.values()].filter(
    (advisory) => accepted[advisory.id] !== advisory.name,
  );
  const stale = Object.keys(accepted).filter((id) => !reported.has(id));
  return { unaccepted, stale, accepted: [...reported.values()].filter((a) => accepted[a.id] === a.name) };
}

function readAuditReport() {
  try {
    return execFileSync("npm", ["audit", "--include=dev", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // npm exits non-zero when it finds anything; the report is still on stdout.
    if (typeof error.stdout === "string" && error.stdout.trim().startsWith("{")) return error.stdout;
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readAuditReport());
  if (report.error) {
    console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(1);
  }
  const { unaccepted, stale, accepted } = evaluateAudit(report);
  for (const advisory of accepted) {
    console.log(`Accepted for build tools only: ${advisory.id} ${advisory.name} (${advisory.severity})`);
  }
  for (const advisory of unaccepted) {
    console.error(`Not accepted: ${advisory.id} ${advisory.name} (${advisory.severity}): ${advisory.title}`);
  }
  for (const id of stale) {
    console.error(`${id} is no longer reported. Remove it from scripts/audit-dev-dependencies.mjs.`);
  }
  if (unaccepted.length > 0 || stale.length > 0) process.exit(1);
  console.log("Development dependency audit passed.");
}
