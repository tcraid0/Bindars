#!/usr/bin/env node
/** Measure document rendering through the optimized Tauri app and real open routes. */

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

import {
  generateDocumentPerformanceFixtures,
  SMARTYPANTS_CURRENT_LIMIT_TARGET,
  SMARTYPANTS_TARGETS,
} from "./generate-document-performance-fixtures.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BINARY = path.join(PROJECT_ROOT, "src-tauri", "target", "release", "bindars");
const DEFAULT_TIMEOUT_MS = 5_000;
const STABLE_POLLS = 4;
const POLL_INTERVAL_MS = 100;
const EVENT_LOOP_PROBE_INTERVAL_MS = 16;
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function parseArguments(argv) {
  const options = {
    binary: DEFAULT_BINARY,
    fixtures: null,
    keepFixtures: false,
    output: null,
    seed: 20_260_806,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    trials: 3,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };

    if (argument === "--binary") options.binary = path.resolve(value());
    else if (argument === "--fixtures") options.fixtures = path.resolve(value());
    else if (argument === "--keep-fixtures") options.keepFixtures = true;
    else if (argument === "--output") options.output = path.resolve(value());
    else if (argument === "--seed") options.seed = Number.parseInt(value(), 10);
    else if (argument === "--timeout-ms") options.timeoutMs = Number.parseInt(value(), 10);
    else if (argument === "--trials") options.trials = Number.parseInt(value(), 10);
    else if (argument === "--help") {
      console.log(`Usage: node scripts/verify-document-performance.mjs [options]\n\nOptions:\n  --binary PATH       Optimized Tauri binary (default: ${DEFAULT_BINARY})\n  --fixtures DIR      Reuse or create fixtures in DIR\n  --keep-fixtures     Keep an automatically-created fixture directory\n  --output PATH       Write detailed JSON results to PATH\n  --seed INTEGER      Deterministic trial-order seed (default: 20260806)\n  --timeout-ms MS     Per-step timeout (default: ${DEFAULT_TIMEOUT_MS})\n  --trials COUNT      Repetitions per case and lifecycle (default: 3)`);
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new Error("--trials must be a positive integer");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }
  if (!Number.isInteger(options.seed)) throw new Error("--seed must be an integer");
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function portableRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isInsideDirectory(directory, candidatePath) {
  const relativePath = path.relative(directory, candidatePath);
  return relativePath === ""
    || (!relativePath.startsWith(`..${path.sep}`)
      && relativePath !== ".."
      && !path.isAbsolute(relativePath));
}

export async function assertOutputOutsideRepository(
  outputPath,
  rootDirectory = PROJECT_ROOT,
) {
  const canonicalRoot = await realpath(rootDirectory);
  let canonicalOutput;
  try {
    canonicalOutput = await realpath(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const canonicalParent = await realpath(path.dirname(outputPath));
    canonicalOutput = path.join(canonicalParent, path.basename(outputPath));
  }

  if (isInsideDirectory(canonicalRoot, canonicalOutput)) {
    throw new Error(
      `Refusing to write machine-specific performance results inside the repository: ${outputPath}`,
    );
  }
}

export async function buildFileIdentityManifest(rootDirectory, relativePaths) {
  const normalizedPaths = [...new Set(relativePaths.map(portableRelativePath))].sort();
  return Promise.all(normalizedPaths.map(async (relativePath) => {
    const absolutePath = path.resolve(rootDirectory, relativePath);
    const relativeToRoot = path.relative(rootDirectory, absolutePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Identity path escapes the source root: ${relativePath}`);
    }

    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolutePath), "utf8");
      return {
        path: relativePath,
        type: "symlink",
        bytes: target.length,
        sha256: sha256(target),
      };
    }
    if (!fileStat.isFile()) {
      throw new Error(`Unsupported untracked identity entry: ${relativePath}`);
    }

    const contents = await readFile(absolutePath);
    return {
      path: relativePath,
      type: "file",
      bytes: contents.length,
      sha256: sha256(contents),
    };
  }));
}

async function nonIgnoredUntrackedPaths(rootDirectory = PROJECT_ROOT) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: rootDirectory, encoding: "buffer", maxBuffer: GIT_OUTPUT_MAX_BUFFER },
  );
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

async function commandOutput(command, args, rootDirectory = PROJECT_ROOT) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: rootDirectory,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return stdout.trim();
}

async function optionalCommandOutput(command, args, rootDirectory = PROJECT_ROOT) {
  try {
    return await commandOutput(command, args, rootDirectory);
  } catch {
    return null;
  }
}

async function reserveTcpPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (port === null) throw new Error("Failed to reserve an inspector port");
  return port;
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`GET ${url} timed out`)));
    request.once("error", reject);
  });
}

async function inspectorSocketUrl(port, deadlineMs) {
  const url = `http://127.0.0.1:${port}/`;
  let lastError = null;
  while (performance.now() < deadlineMs) {
    try {
      const response = await httpGet(url, 1_000);
      const match = response.body.match(/\/socket\/[^'"?]+/);
      if (response.statusCode === 200 && match) return `ws://127.0.0.1:${port}${match[0]}`;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(`WebKit inspector did not become ready${lastError ? `: ${lastError.message}` : ""}`);
}

function sanitizeConsoleMessage(message) {
  if (!message || typeof message !== "object") return message;
  const text = typeof message.text === "string" ? message.text : "";
  return {
    source: message.source ?? null,
    level: message.level ?? null,
    text: text.length > 500 ? `${text.slice(0, 500)}…` : text,
    url: message.url ?? null,
    line: message.line ?? null,
    column: message.column ?? null,
  };
}

class RemoteInspector {
  constructor(socketUrl, timeoutMs) {
    this.socketUrl = socketUrl;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.targetId = null;
    this.outerId = 0;
    this.innerId = 0;
    this.pendingInner = new Map();
    this.consoleMessages = [];
    this.protocolErrors = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.socketUrl, {
        origin: this.socketUrl.replace(/^ws:/, "http:").replace(/\/socket\/.*$/, ""),
      });
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error("Inspector WebSocket timed out")), this.timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("message", (data) => this.handleMessage(String(data)));
    });

    const deadline = performance.now() + this.timeoutMs;
    while (!this.targetId && performance.now() < deadline) await delay(10);
    if (!this.targetId) throw new Error("Inspector did not expose a page target");
    await this.sendToTarget("Console.enable");
    return this;
  }

  handleMessage(rawMessage) {
    const message = JSON.parse(rawMessage);
    if (message.method === "Target.targetCreated") {
      const targetInfo = message.params?.targetInfo;
      if (targetInfo?.type === "page" && !targetInfo.isProvisional) {
        this.targetId = targetInfo.targetId;
      }
      return;
    }
    if (message.method === "Target.didCommitProvisionalTarget") {
      if (this.targetId === message.params?.oldTargetId) this.targetId = message.params.newTargetId;
      return;
    }
    if (message.method !== "Target.dispatchMessageFromTarget") return;

    const inner = JSON.parse(message.params.message);
    if (inner.id) {
      const pending = this.pendingInner.get(inner.id);
      if (!pending) return;
      this.pendingInner.delete(inner.id);
      clearTimeout(pending.timer);
      if (inner.error) pending.reject(new Error(inner.error.message ?? JSON.stringify(inner.error)));
      else pending.resolve(inner.result);
      return;
    }
    if (inner.method === "Console.messageAdded") {
      this.consoleMessages.push(sanitizeConsoleMessage(inner.params?.message ?? inner.params));
    } else if (inner.method?.endsWith("exceptionThrown")) {
      this.protocolErrors.push(inner.params);
    }
  }

  sendToTarget(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.targetId) {
      return Promise.reject(new Error("Inspector target is unavailable"));
    }
    const innerId = ++this.innerId;
    const outerMessage = {
      id: ++this.outerId,
      method: "Target.sendMessageToTarget",
      params: {
        targetId: this.targetId,
        message: JSON.stringify({ id: innerId, method, params }),
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInner.delete(innerId);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pendingInner.set(innerId, { resolve, reject, timer });
      this.socket.send(JSON.stringify(outerMessage));
    });
  }

  async evaluate(expression, timeoutMs = this.timeoutMs) {
    const response = await this.sendToTarget(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      timeoutMs,
    );
    if (response?.wasThrown) {
      throw new Error(response.result?.description ?? "Runtime.evaluate threw");
    }
    return response?.result?.value;
  }

  async evaluateJson(expression, timeoutMs = this.timeoutMs) {
    const value = await this.evaluate(`JSON.stringify(${expression})`, timeoutMs);
    return JSON.parse(value);
  }

  close() {
    for (const pending of this.pendingInner.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Inspector closed"));
    }
    this.pendingInner.clear();
    this.socket?.close();
  }
}

function readProcessStatus(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const field = (name) => status.match(new RegExp(`^${name}:\\s+([^\\n]+)$`, "m"))?.[1] ?? null;
    const integerField = (name) => {
      const value = field(name);
      return value ? Number.parseInt(value, 10) : null;
    };
    return {
      pid,
      name: field("Name"),
      parentPid: integerField("PPid"),
      vmHwmKiB: integerField("VmHWM"),
      vmRssKiB: integerField("VmRSS"),
    };
  } catch {
    return null;
  }
}

function descendantProcesses(rootPid) {
  const descendants = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const status = readProcessStatus(pid);
    if (!status) continue;
    descendants.push(status);
    try {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      pending.push(...children);
    } catch {
      // The process may exit between status and children reads.
    }
  }
  return descendants;
}

function readPssKiB(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    return Number.parseInt(rollup.match(/^Pss:\s+(\d+) kB$/m)?.[1] ?? "", 10) || null;
  } catch {
    return null;
  }
}

function isWebProcess(processRow) {
  return processRow.name?.startsWith("WebKitWebProces") ?? false;
}

class ProcessMemoryMonitor {
  constructor(rootPid) {
    this.rootPid = rootPid;
    this.byPid = new Map();
    this.observedWebProcessPids = new Set();
    this.lastObservedWebProcessPids = new Set();
    this.webProcessReplacementObserved = false;
    this.timer = setInterval(() => this.sample(), 100);
    this.sample();
  }

  sample() {
    const descendants = descendantProcesses(this.rootPid);
    const currentWebProcessPids = new Set();
    for (const status of descendants) {
      const previous = this.byPid.get(status.pid);
      this.byPid.set(status.pid, {
        ...status,
        vmHwmKiB: Math.max(previous?.vmHwmKiB ?? 0, status.vmHwmKiB ?? 0),
      });
      if (isWebProcess(status)) {
        currentWebProcessPids.add(status.pid);
        this.observedWebProcessPids.add(status.pid);
      }
    }

    if (currentWebProcessPids.size > 0) {
      const sharesPriorPid = [...currentWebProcessPids].some(
        (pid) => this.lastObservedWebProcessPids.has(pid),
      );
      if (this.lastObservedWebProcessPids.size > 0 && !sharesPriorPid) {
        this.webProcessReplacementObserved = true;
      }
      this.lastObservedWebProcessPids = currentWebProcessPids;
    }
  }

  finish() {
    clearInterval(this.timer);
    this.sample();
    const processRows = [...this.byPid.values()];
    const liveDescendants = descendantProcesses(this.rootPid);
    const liveWebProcessPids = liveDescendants
      .filter(isWebProcess)
      .map((row) => row.pid)
      .sort((left, right) => left - right);
    const endOfTrialPss = liveDescendants.map((row) => ({
      pid: row.pid,
      name: row.name,
      pssKiB: readPssKiB(row.pid),
    }));
    return {
      webProcesses: processRows.filter(isWebProcess),
      observedWebProcessPids: [...this.observedWebProcessPids].sort((left, right) => left - right),
      liveWebProcessPids,
      webProcessReplacementObserved: this.webProcessReplacementObserved,
      processTree: processRows,
      endOfTrialProcessTreePssKiB: endOfTrialPss.reduce(
        (sum, row) => sum + (row.pssKiB ?? 0),
        0,
      ),
      endOfTrialPssByPid: endOfTrialPss,
    };
  }
}

function snapshotExpression(marker = null) {
  const serializedMarker = JSON.stringify(marker);
  return `(() => {
    const article = document.querySelector("main article");
    const articleText = article?.textContent ?? "";
    const bodyText = document.body?.innerText ?? "";
    const marker = ${serializedMarker};
    const rect = article?.getBoundingClientRect();
    void document.body?.offsetHeight;
    return {
      articleCharacters: articleText.length,
      articleHeight: rect?.height ?? 0,
      bodyNodes: document.getElementsByTagName("*").length,
      curlyQuotes: articleText.includes("“hello”"),
      endMarkerPresent: marker === null ? null : articleText.includes(marker),
      errorBoundary: Boolean(document.querySelector('[data-testid="app-error-boundary"]')),
      eventLoop: globalThis.__BINDARS_DOCUMENT_PERFORMANCE_EVENT_LOOP__
        ? { ...globalThis.__BINDARS_DOCUMENT_PERFORMANCE_EVENT_LOOP__ }
        : null,
      events: (globalThis.__BINDARS_DOCUMENT_PERFORMANCE_EVENTS__ ?? []).slice(),
      headingCount: article?.querySelectorAll("h1, h2, h3, h4, h5, h6").length ?? 0,
      loading: bodyText.includes("Opening file..."),
      notice: document.querySelector('main [role="alert"]')?.textContent ?? null,
      presentation: Boolean(document.querySelector(".presentation-overlay")),
      readerPresent: Boolean(article),
      straightQuotes: articleText.includes('"hello"'),
      title: document.title,
      tocLinks: document.querySelectorAll('nav a, [data-testid="toc"] a').length,
    };
  })()`;
}

function isReaderReady(snapshot) {
  return snapshot.readerPresent && snapshot.endMarkerPresent && !snapshot.loading;
}

function stableSignature(snapshot) {
  return JSON.stringify({
    articleCharacters: snapshot.articleCharacters,
    articleHeight: snapshot.articleHeight,
    bodyNodes: snapshot.bodyNodes,
    events: snapshot.events.length,
    headingCount: snapshot.headingCount,
    notice: snapshot.notice,
    presentation: snapshot.presentation,
    tocLinks: snapshot.tocLinks,
  });
}

class SnapshotTimeoutError extends Error {
  constructor(lastSnapshot, lastEvaluationError) {
    const details = lastEvaluationError ? `; last inspector error: ${lastEvaluationError}` : "";
    super(`Timed out waiting for a quiet-window DOM${details}`);
    this.name = "SnapshotTimeoutError";
    this.lastSnapshot = lastSnapshot;
    this.lastEvaluationError = lastEvaluationError;
  }
}

async function waitForSnapshot(inspector, marker, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let stableCount = 0;
  let previousSignature = null;
  let committedAt = null;
  let latest = null;
  let lastEvaluationError = null;

  while (performance.now() < deadline) {
    const remaining = Math.max(1_000, deadline - performance.now());
    try {
      latest = await inspector.evaluateJson(snapshotExpression(marker), remaining);
      if (latest.errorBoundary) throw new Error("React root error boundary rendered");
      if (predicate(latest)) {
        committedAt ??= performance.now();
        const signature = stableSignature(latest);
        stableCount = signature === previousSignature ? stableCount + 1 : 1;
        previousSignature = signature;
        if (stableCount >= STABLE_POLLS) {
          return { committedAt, settledAt: performance.now(), snapshot: latest };
        }
      } else {
        stableCount = 0;
        previousSignature = null;
      }
    } catch (error) {
      if (error.message.includes("React root error")) throw error;
      lastEvaluationError = error instanceof Error ? error.message : String(error);
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new SnapshotTimeoutError(latest, lastEvaluationError);
}

function keyboardExpression(key, modifiers = {}) {
  return `(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ key, bubbles: true, ...modifiers })}));
    return true;
  })()`;
}

async function waitForCondition(inspector, expression, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await inspector.evaluate(expression, Math.max(1_000, deadline - performance.now()))) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for condition: ${expression}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function launchApp(binary, filePath, timeoutMs) {
  const port = await reserveTcpPort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "bindars-document-performance-profile-"));
  const startedAt = performance.now();
  const child = spawn(binary, [filePath], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      GDK_BACKEND: process.env.BINDARS_PERFORMANCE_GDK_BACKEND ?? "x11",
      WEBKIT_DISABLE_DMABUF_RENDERER:
        process.env.BINDARS_PERFORMANCE_DISABLE_DMABUF ?? "1",
      WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${port}`,
      XDG_CACHE_HOME: path.join(profile, "cache"),
      XDG_CONFIG_HOME: path.join(profile, "config"),
      XDG_DATA_HOME: path.join(profile, "data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout = `${output.stdout}${chunk}`.slice(-16_384);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = `${output.stderr}${chunk}`.slice(-16_384);
  });

  const memoryMonitor = new ProcessMemoryMonitor(child.pid);
  try {
    const socketUrl = await inspectorSocketUrl(port, performance.now() + timeoutMs);
    const inspector = await new RemoteInspector(socketUrl, timeoutMs).connect();
    return { child, inspector, memoryMonitor, output, profile, startedAt };
  } catch (error) {
    memoryMonitor.finish();
    await stopProcess(child);
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

async function finishApp(app) {
  const memory = app.memoryMonitor.finish();
  app.inspector.close();
  await stopProcess(app.child);
  await rm(app.profile, { recursive: true, force: true });
  return memory;
}

function appDiagnostics(app) {
  return {
    consoleMessages: app.inspector.consoleMessages,
    protocolErrors: app.inspector.protocolErrors,
    processOutput: app.output,
  };
}

function attachSnapshotTimeoutDiagnostics(result, error) {
  if (!(error instanceof SnapshotTimeoutError)) return;
  result.lastSnapshotBeforeTimeout = error.lastSnapshot;
  result.lastEvaluationError = error.lastEvaluationError;
  result.observedPipelineEventCountBeforeTimeout = Array.isArray(error.lastSnapshot?.events)
    ? error.lastSnapshot.events.length
    : null;
  result.observedEventLoopMaxDelayMsBeforeTimeout =
    error.lastSnapshot?.eventLoop?.maxDelayMs ?? null;
}

async function sourceIntegrity(filePath, testCase) {
  const sourceSha256AtEnd = sha256(await readFile(filePath));
  return {
    sourceSha256AtEnd,
    sourceBytesPreserved: sourceSha256AtEnd === testCase.sha256,
  };
}

function validatePerformanceProbeSnapshot(snapshot) {
  const failures = [];
  if (snapshot.eventLoop?.intervalMs !== EVENT_LOOP_PROBE_INTERVAL_MS) {
    failures.push("instrumented event-loop probe is missing or has an unexpected interval");
  }
  return failures;
}

function validateAcceptedReaderSnapshot(snapshot) {
  const failures = validatePerformanceProbeSnapshot(snapshot);
  if (!snapshot.readerPresent || !snapshot.endMarkerPresent) failures.push("missing non-empty end-marked reader DOM");
  if (snapshot.loading) failures.push("opening state did not clear");
  if (snapshot.errorBoundary) failures.push("React root error boundary rendered");
  if (snapshot.headingCount < 1) failures.push("heading extraction fixture did not render a heading");
  if (snapshot.events.length === 0) failures.push("instrumented pipeline events are missing; rebuild with BINDARS_DOCUMENT_PERFORMANCE_PROBE=1");
  return failures;
}

function validateSmartypantsSnapshot(testCase, snapshot) {
  const failures = validateAcceptedReaderSnapshot(snapshot);

  const relevantEvents = snapshot.events.filter(
    (event) => event.smartypants?.chars === testCase.assembledSmartypantsChars,
  );
  if (relevantEvents.length === 0) failures.push("no pipeline event matched the exact assembled-character target");
  const expectedApplied = testCase.expected === "accepted";
  if (relevantEvents.some((event) => event.smartypants.applied !== expectedApplied)) {
    failures.push(`smartypants applied state did not match ${testCase.expected}`);
  }
  if (expectedApplied && !snapshot.curlyQuotes) failures.push("accepted smartypants output lacks curly quotes");
  if (!expectedApplied && !snapshot.straightQuotes) failures.push("degraded smartypants output lacks straight quotes");
  return { failures, relevantEvents };
}

async function runColdTrial(options, fixturesDir, testCase, trialIndex) {
  const filePath = path.join(fixturesDir, testCase.fileName);
  const app = await launchApp(options.binary, filePath, options.timeoutMs);
  let result;
  try {
    const timing = await waitForSnapshot(
      app.inspector,
      testCase.endMarker ?? null,
      testCase.expected === "refused"
        ? (snapshot) => Boolean(snapshot.notice?.includes("too large or complex"))
        : isReaderReady,
      options.timeoutMs,
    );
    result = {
      route: "cold-direct-open",
      caseId: testCase.id,
      trial: trialIndex,
      commitMs: timing.committedAt - app.startedAt,
      settledMs: timing.settledAt - app.startedAt,
      snapshot: timing.snapshot,
      failures: [],
      ...appDiagnostics(app),
    };

    if (testCase.kind === "smartypants") {
      const validation = validateSmartypantsSnapshot(testCase, timing.snapshot);
      result.failures.push(...validation.failures);
      result.pipelineEvents = validation.relevantEvents;
    } else if (testCase.expected === "refused") {
      result.failures.push(...validatePerformanceProbeSnapshot(timing.snapshot));
      if (!timing.snapshot.notice?.includes("too large or complex")) result.failures.push("truthful refusal notice is missing");
      if (timing.snapshot.events.length !== 0) result.failures.push("refused source entered the Markdown pipeline");
      result.pipelineEvents = timing.snapshot.events;
      await app.inspector.evaluate("window.__bindarsPrintCalls = 0; window.print = () => { window.__bindarsPrintCalls += 1; }; true");
      await app.inspector.evaluate(keyboardExpression("F5"));
      await delay(200);
      result.presentationBlocked = !(await app.inspector.evaluate(
        "Boolean(document.querySelector('.presentation-overlay'))",
      ));
      if (!result.presentationBlocked) {
        result.failures.push("refused source entered presentation mode");
      }
      await app.inspector.evaluate(keyboardExpression("p", { ctrlKey: true }));
      await waitForCondition(app.inspector, "window.__bindarsPrintCalls === 1", options.timeoutMs);
      result.printNoticeVisible = await app.inspector.evaluate(
        "Boolean(document.querySelector('main [role=\"alert\"]'))",
      );
      if (!result.printNoticeVisible) {
        result.failures.push("print did not retain the refusal notice");
      }
      await app.inspector.evaluate(keyboardExpression("e", { ctrlKey: true }));
      await waitForCondition(app.inspector, "Boolean(document.querySelector('.cm-editor'))", options.timeoutMs);
      result.editorAvailable = await app.inspector.evaluate(
        "Boolean(document.querySelector('.cm-editor'))",
      );
      await app.inspector.evaluate(`(() => {
        const content = document.querySelector('.cm-content');
        content?.focus();
        content?.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', ctrlKey: true, bubbles: true}));
        return true;
      })()`);
      await delay(200);
      result.editorEndMarkerVisible = await app.inspector.evaluate(
        `document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(testCase.sourceMarker)}) ?? false`,
      );
      if (!result.editorEndMarkerVisible) {
        result.failures.push("editor did not expose the exact end marker after moving to the document end");
      }
      Object.assign(result, await sourceIntegrity(filePath, testCase));
      if (!result.sourceBytesPreserved) {
        result.failures.push("source bytes changed during refusal interactions");
      }
    } else {
      result.failures.push(...validateAcceptedReaderSnapshot(timing.snapshot));
      result.pipelineEvents = timing.snapshot.events;
      Object.assign(result, await sourceIntegrity(filePath, testCase));
      if (!result.sourceBytesPreserved) {
        result.failures.push("source bytes changed while rendering the accepted boundary");
      }
    }
    return result;
  } catch (error) {
    result ??= {
      route: "cold-direct-open",
      caseId: testCase.id,
      trial: trialIndex,
      commitMs: null,
      settledMs: null,
      failures: [],
      ...appDiagnostics(app),
    };
    attachSnapshotTimeoutDiagnostics(result, error);
    result.failures.push(
      `trial failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (testCase.kind === "source-volume") {
      Object.assign(result, await sourceIntegrity(filePath, testCase));
      if (!result.sourceBytesPreserved) {
        result.failures.push("source bytes changed during the failed source-boundary trial");
      }
    }
    return result;
  } finally {
    const memory = await finishApp(app);
    if (result) result.memory = memory;
  }
}

async function resetPerformanceProbe(inspector) {
  await inspector.evaluate(`(() => {
    globalThis.__BINDARS_DOCUMENT_PERFORMANCE_EVENTS__ = [];
    globalThis.__BINDARS_DOCUMENT_PERFORMANCE_RESET_EVENT_LOOP__?.();
    return true;
  })()`);
}

async function openLinkedFixture(inspector, testCase, timeoutMs) {
  await resetPerformanceProbe(inspector);
  const clicked = await inspector.evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((candidate) => candidate.getAttribute('href')?.endsWith(${JSON.stringify(testCase.fileName)}));
    if (!link) return false;
    link.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Control document link missing for ${testCase.fileName}`);
  return waitForSnapshot(
    inspector,
    testCase.endMarker,
    isReaderReady,
    timeoutMs,
  );
}

async function returnToControl(inspector, control, timeoutMs) {
  const clicked = await inspector.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Go back"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("App back control was unavailable");
  await waitForSnapshot(
    inspector,
    control.endMarker,
    isReaderReady,
    timeoutMs,
  );
}

async function runWarmLifecycle(options, fixturesDir, manifest, orderedCases, trialIndex) {
  const controlPath = path.join(fixturesDir, manifest.control.fileName);
  const app = await launchApp(options.binary, controlPath, options.timeoutMs);
  let result;
  try {
    await waitForSnapshot(
      app.inspector,
      manifest.control.endMarker,
      isReaderReady,
      options.timeoutMs,
    );
    result = {
      route: "warm-navigation-and-remounts",
      trial: trialIndex,
      navigations: [],
      remount: null,
      presentationMount: null,
      failures: [],
      ...appDiagnostics(app),
    };

    for (const testCase of orderedCases) {
      const startedAt = performance.now();
      const timing = await openLinkedFixture(app.inspector, testCase, options.timeoutMs);
      const validation = validateSmartypantsSnapshot(testCase, timing.snapshot);
      result.navigations.push({
        caseId: testCase.id,
        commitMs: timing.committedAt - startedAt,
        settledMs: timing.settledAt - startedAt,
        eventLoop: timing.snapshot.eventLoop,
        pipelineEvents: validation.relevantEvents,
        pipelineCount: validation.relevantEvents.length,
        failures: validation.failures,
      });
      result.failures.push(...validation.failures.map((failure) => `${testCase.id}: ${failure}`));

      if (testCase.assembledSmartypantsChars === 10_000) {
        await app.inspector.evaluate(keyboardExpression("e", { ctrlKey: true }));
        await waitForCondition(app.inspector, "Boolean(document.querySelector('.cm-editor'))", options.timeoutMs);
        await resetPerformanceProbe(app.inspector);
        const remountStartedAt = performance.now();
        await app.inspector.evaluate(keyboardExpression("e", { ctrlKey: true }));
        const remountTiming = await waitForSnapshot(
          app.inspector,
          testCase.endMarker,
          isReaderReady,
          options.timeoutMs,
        );
        const remountEvents = remountTiming.snapshot.events.filter(
          (event) => event.smartypants?.chars === 10_000,
        );
        result.remount = {
          commitMs: remountTiming.committedAt - remountStartedAt,
          settledMs: remountTiming.settledAt - remountStartedAt,
          eventLoop: remountTiming.snapshot.eventLoop,
          pipelineCount: remountEvents.length,
          pipelineEvents: remountEvents,
        };

        await resetPerformanceProbe(app.inspector);
        const presentationStartedAt = performance.now();
        await app.inspector.evaluate(keyboardExpression("F5"));
        await waitForCondition(app.inspector, "Boolean(document.querySelector('.presentation-overlay'))", options.timeoutMs);
        const presentationTiming = await waitForSnapshot(
          app.inspector,
          testCase.endMarker,
          (snapshot) => snapshot.presentation && snapshot.endMarkerPresent,
          options.timeoutMs,
        );
        const presentationEvents = presentationTiming.snapshot.events.filter(
          (event) => event.smartypants?.chars === 10_000,
        );
        result.presentationMount = {
          commitMs: presentationTiming.committedAt - presentationStartedAt,
          settledMs: presentationTiming.settledAt - presentationStartedAt,
          eventLoop: presentationTiming.snapshot.eventLoop,
          pipelineCount: presentationEvents.length,
          pipelineEvents: presentationEvents,
        };
        await app.inspector.evaluate(keyboardExpression("Escape"));
        await waitForCondition(app.inspector, "!document.querySelector('.presentation-overlay')", options.timeoutMs);
      }

      await returnToControl(app.inspector, manifest.control, options.timeoutMs);
    }
    return result;
  } catch (error) {
    result ??= {
      route: "warm-navigation-and-remounts",
      trial: trialIndex,
      navigations: [],
      remount: null,
      presentationMount: null,
      failures: [],
      ...appDiagnostics(app),
    };
    attachSnapshotTimeoutDiagnostics(result, error);
    result.failures.push(
      `lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  } finally {
    const memory = await finishApp(app);
    if (result) result.memory = memory;
  }
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function numericSummary(values) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return null;
  return {
    minimum: Math.min(...finiteValues),
    median: median(finiteValues),
    maximum: Math.max(...finiteValues),
  };
}

export function summarizePerformanceResults(results) {
  const groups = new Map();
  for (const result of results.coldTrials) {
    const trials = groups.get(result.caseId) ?? [];
    const pipelineEventsObserved = Array.isArray(result.pipelineEvents);
    const perExecutionTransformMs = pipelineEventsObserved
      ? result.pipelineEvents
        .map((event) => event.smartypants?.transformMs)
        .filter(Number.isFinite)
      : null;
    trials.push({
      trial: result.trial,
      commitMs: result.commitMs,
      settledMs: result.settledMs,
      eventLoopMaxDelayMs: result.snapshot?.eventLoop?.maxDelayMs ?? null,
      observedEventLoopMaxDelayMsBeforeTimeout:
        result.observedEventLoopMaxDelayMsBeforeTimeout ?? null,
      pipelineExecutionCount: pipelineEventsObserved ? result.pipelineEvents.length : null,
      observedPipelineEventCountBeforeTimeout:
        result.observedPipelineEventCountBeforeTimeout ?? null,
      perExecutionTransformMs,
      totalTransformMs: perExecutionTransformMs === null
        ? null
        : perExecutionTransformMs.reduce((sum, value) => sum + value, 0),
    });
    groups.set(result.caseId, trials);
  }

  return Object.fromEntries([...groups].map(([caseId, trials]) => {
    trials.sort((left, right) => left.trial - right.trial);
    const summary = {
      commitMs: numericSummary(trials.map((trial) => trial.commitMs)),
      settledMs: numericSummary(trials.map((trial) => trial.settledMs)),
      eventLoopMaxDelayMs: numericSummary(
        trials.map((trial) => trial.eventLoopMaxDelayMs),
      ),
      pipelineExecutionsPerOpen: numericSummary(
        trials.map((trial) => trial.pipelineExecutionCount),
      ),
      trials,
    };

    if (caseId.startsWith("smartypants-")) {
      summary.smartypants = {
        perExecutionTransformMs: numericSummary(
          trials.flatMap((trial) => trial.perExecutionTransformMs ?? []),
        ),
        totalTransformMsPerOpen: numericSummary(
          trials.map((trial) => trial.totalTransformMs),
        ),
      };
    }
    return [caseId, summary];
  }));
}

export async function sourceTreeIdentity(rootDirectory = PROJECT_ROOT) {
  const { stdout: trackedDiff } = await execFileAsync(
    "git",
    ["diff", "HEAD", "--binary", "--"],
    { cwd: rootDirectory, encoding: "buffer", maxBuffer: GIT_OUTPUT_MAX_BUFFER },
  );
  const untrackedFiles = await buildFileIdentityManifest(
    rootDirectory,
    await nonIgnoredUntrackedPaths(rootDirectory),
  );
  return {
    branch: await commandOutput("git", ["branch", "--show-current"], rootDirectory),
    head: await commandOutput("git", ["rev-parse", "HEAD"], rootDirectory),
    trackedDiffAgainstHeadSha256: sha256(trackedDiff),
    nonIgnoredUntrackedFiles: untrackedFiles,
    nonIgnoredUntrackedFilesManifestSha256: sha256(JSON.stringify(untrackedFiles)),
  };
}

async function environmentIdentity(binary) {
  const binaryBytes = await readFile(binary);
  const binaryStat = await stat(binary);
  const osRelease = await readFile("/etc/os-release", "utf8").catch(() => "");
  return {
    binary: {
      path: binary,
      bytes: binaryStat.size,
      modifiedAt: binaryStat.mtime.toISOString(),
      sha256: sha256(binaryBytes),
    },
    source: await sourceTreeIdentity(),
    host: {
      architecture: os.arch(),
      cpu: os.cpus()[0]?.model ?? null,
      cpuLogicalCount: os.cpus().length,
      displayBackend: process.env.BINDARS_PERFORMANCE_GDK_BACKEND ?? "x11",
      disableDmabufRenderer: process.env.BINDARS_PERFORMANCE_DISABLE_DMABUF ?? "1",
      kernel: `${os.type()} ${os.release()}`,
      memoryBytes: os.totalmem(),
      osRelease: Object.fromEntries(osRelease.split("\n").flatMap((line) => {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        return match ? [[match[1], match[2].replace(/^"|"$/g, "")]] : [];
      })),
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
      webkitGtk: await optionalCommandOutput(
        "pkg-config",
        ["--modversion", "webkit2gtk-4.1"],
      ),
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  if (options.output) {
    await assertOutputOutsideRepository(options.output);
  }

  const autoFixtures = options.fixtures === null;
  const fixturesDir = options.fixtures
    ?? await mkdtemp(path.join(os.tmpdir(), "bindars-document-performance-fixtures-"));
  const manifest = await generateDocumentPerformanceFixtures(fixturesDir);
  const random = seededRandom(options.seed);
  const smartCases = manifest.cases.filter(
    (testCase) => testCase.kind === "smartypants" && SMARTYPANTS_TARGETS.includes(testCase.assembledSmartypantsChars),
  );
  const warmSmartCases = smartCases.filter((testCase) => testCase.shape === "punctuation");
  const currentLimitCase = manifest.cases.find(
    (testCase) => testCase.shape === "punctuation"
      && testCase.assembledSmartypantsChars === SMARTYPANTS_CURRENT_LIMIT_TARGET,
  );
  const degradedCase = manifest.cases.find((testCase) => testCase.expected === "degraded");
  const acceptedSourceCases = manifest.cases.filter(
    (testCase) => testCase.kind === "source-volume" && testCase.expected === "accepted",
  );
  const refusedCase = manifest.cases.find((testCase) => testCase.expected === "refused");
  if (
    !manifest.coldControl
    || !currentLimitCase
    || !degradedCase
    || acceptedSourceCases.length === 0
    || !refusedCase
  ) {
    throw new Error("Generated manifest is incomplete");
  }

  const coldSchedule = shuffled(
    Array.from({ length: options.trials }, (_, trialIndex) =>
      [
        manifest.coldControl,
        ...smartCases,
        currentLimitCase,
        degradedCase,
        ...acceptedSourceCases,
        refusedCase,
      ].map((testCase) => ({ testCase, trialIndex: trialIndex + 1 })),
    ).flat(),
    random,
  );
  const results = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    protocol: {
      trials: options.trials,
      timeoutMs: options.timeoutMs,
      seed: options.seed,
      quietWindowPolls: STABLE_POLLS,
      quietWindowPollIntervalMs: POLL_INTERVAL_MS,
      eventLoopProbeIntervalMs: EVENT_LOOP_PROBE_INTERVAL_MS,
      coldOrder: coldSchedule.map(({ testCase, trialIndex }) => `${testCase.id}:${trialIndex}`),
    },
    identity: await environmentIdentity(options.binary),
    fixtureManifest: manifest,
    coldTrials: [],
    warmLifecycles: [],
    failures: [],
  };

  try {
    for (const scheduled of coldSchedule) {
      console.error(`cold ${scheduled.testCase.id} trial ${scheduled.trialIndex}/${options.trials}`);
      const result = await runColdTrial(
        options,
        fixturesDir,
        scheduled.testCase,
        scheduled.trialIndex,
      );
      results.coldTrials.push(result);
      results.failures.push(...result.failures.map((failure) => `${result.caseId} trial ${result.trial}: ${failure}`));
    }

    for (let trialIndex = 1; trialIndex <= options.trials; trialIndex += 1) {
      console.error(`warm lifecycle trial ${trialIndex}/${options.trials}`);
      const orderedCases = shuffled(warmSmartCases, random);
      const result = await runWarmLifecycle(
        options,
        fixturesDir,
        manifest,
        orderedCases,
        trialIndex,
      );
      result.caseOrder = orderedCases.map((testCase) => testCase.id);
      results.warmLifecycles.push(result);
      results.failures.push(...result.failures.map((failure) => `warm trial ${trialIndex}: ${failure}`));
    }
  } finally {
    if (autoFixtures && !options.keepFixtures) {
      await rm(fixturesDir, { recursive: true, force: true });
    } else {
      results.fixturesDirectory = fixturesDir;
    }
  }

  results.summary = summarizePerformanceResults(results);
  const serialized = `${JSON.stringify(results, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, serialized, "utf8");
    console.log(
      JSON.stringify(
        {
          output: options.output,
          failureCount: results.failures.length,
          failures: results.failures,
          detailedSummaryWritten: true,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(serialized);
  }
  if (results.failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
