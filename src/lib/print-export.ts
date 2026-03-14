export const PRINT_PREPARE_TIMEOUT_MS = 2_500;
export const PRINT_CLEANUP_TIMEOUT_MS = 30_000;
const PRINT_LAYOUT_SETTLE_FRAMES = 2;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

interface FontSetLike {
  ready: Promise<unknown>;
}

interface PrintImageLike {
  complete: boolean;
  addEventListener(type: "load" | "error", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "load" | "error", listener: () => void): void;
}

interface MermaidDiagramLike {
  matches(selector: string): boolean;
  querySelector(selector: string): unknown;
}

interface QueryRootLike {
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

interface WaitOptions {
  timeoutMs?: number;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}

interface FrameOptions {
  requestAnimationFrameFn?: typeof globalThis.requestAnimationFrame;
  setTimeoutFn?: typeof globalThis.setTimeout;
}

interface PreparePrintDocumentOptions extends WaitOptions, FrameOptions {
  fonts?: FontSetLike | null;
  root?: QueryRootLike | null;
  settleFrames?: number;
}

export function createPrintCleanupController(
  cleanup: () => void,
  timeoutMs = PRINT_CLEANUP_TIMEOUT_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
) {
  let timeoutHandle: TimeoutHandle | null = null;

  return {
    arm() {
      if (timeoutHandle !== null) {
        clearTimeoutFn(timeoutHandle);
      }
      timeoutHandle = setTimeoutFn(() => {
        timeoutHandle = null;
        cleanup();
      }, timeoutMs);
    },
    disarm() {
      if (timeoutHandle === null) {
        return;
      }
      clearTimeoutFn(timeoutHandle);
      timeoutHandle = null;
    },
  };
}

export async function preparePrintDocument({
  fonts = typeof document !== "undefined" ? document.fonts : null,
  root,
  timeoutMs = PRINT_PREPARE_TIMEOUT_MS,
  requestAnimationFrameFn = globalThis.requestAnimationFrame,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  settleFrames = PRINT_LAYOUT_SETTLE_FRAMES,
}: PreparePrintDocumentOptions): Promise<void> {
  await waitForAnimationFrames(settleFrames, { requestAnimationFrameFn, setTimeoutFn });

  await Promise.all([
    waitForFonts(fonts, { timeoutMs, setTimeoutFn, clearTimeoutFn }),
    waitForImages(getImages(root), { timeoutMs, setTimeoutFn, clearTimeoutFn }),
    waitForMermaidDiagrams(root, { timeoutMs, requestAnimationFrameFn, setTimeoutFn }),
  ]);

  await waitForAnimationFrames(1, { requestAnimationFrameFn, setTimeoutFn });
}

export async function waitForFonts(
  fonts: FontSetLike | null | undefined,
  {
    timeoutMs = PRINT_PREPARE_TIMEOUT_MS,
    setTimeoutFn = globalThis.setTimeout,
  }: WaitOptions = {},
): Promise<void> {
  if (!fonts?.ready) {
    return;
  }

  await Promise.race([
    fonts.ready.catch(() => undefined),
    waitForTimeout(timeoutMs, setTimeoutFn),
  ]);
}

export async function waitForImages(
  images: readonly PrintImageLike[],
  {
    timeoutMs = PRINT_PREPARE_TIMEOUT_MS,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  }: WaitOptions = {},
): Promise<void> {
  const pending = images.filter((image) => !image.complete);
  if (pending.length === 0) {
    return;
  }

  await Promise.race([
    Promise.allSettled(
      pending.map((image) => waitForImage(image, timeoutMs, setTimeoutFn, clearTimeoutFn)),
    ),
    waitForTimeout(timeoutMs, setTimeoutFn),
  ]);
}

export async function waitForMermaidDiagrams(
  root: QueryRootLike | null | undefined,
  {
    timeoutMs = PRINT_PREPARE_TIMEOUT_MS,
    requestAnimationFrameFn = globalThis.requestAnimationFrame,
    setTimeoutFn = globalThis.setTimeout,
  }: Pick<PreparePrintDocumentOptions, "timeoutMs" | "requestAnimationFrameFn" | "setTimeoutFn"> = {},
): Promise<void> {
  if (!root || mermaidDiagramsReady(root)) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitForAnimationFrames(1, { requestAnimationFrameFn, setTimeoutFn });
    if (mermaidDiagramsReady(root)) {
      return;
    }
  }
}

export async function waitForAnimationFrames(
  frameCount: number,
  {
    requestAnimationFrameFn = globalThis.requestAnimationFrame,
    setTimeoutFn = globalThis.setTimeout,
  }: FrameOptions = {},
): Promise<void> {
  if (frameCount <= 0) {
    return;
  }

  for (let remaining = frameCount; remaining > 0; remaining -= 1) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrameFn === "function") {
        requestAnimationFrameFn(() => resolve());
        return;
      }
      setTimeoutFn(() => resolve(), 16);
    });
  }
}

function waitForImage(
  image: PrintImageLike,
  timeoutMs: number,
  setTimeoutFn: typeof globalThis.setTimeout,
  clearTimeoutFn: typeof globalThis.clearTimeout,
): Promise<void> {
  if (image.complete) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeoutFn(timeoutHandle);
      image.removeEventListener("load", finish);
      image.removeEventListener("error", finish);
      resolve();
    };

    const timeoutHandle = setTimeoutFn(finish, timeoutMs);
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
  });
}

function waitForTimeout(
  timeoutMs: number,
  setTimeoutFn: typeof globalThis.setTimeout,
): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeoutFn(() => {
      resolve();
    }, timeoutMs);
  });
}

function getImages(root: QueryRootLike | null | undefined): PrintImageLike[] {
  if (!root) {
    return [];
  }

  return Array.from(root.querySelectorAll("img")) as PrintImageLike[];
}

function mermaidDiagramsReady(root: QueryRootLike): boolean {
  const diagrams = Array.from(root.querySelectorAll(".mermaid-diagram")) as MermaidDiagramLike[];
  if (diagrams.length === 0) {
    return true;
  }

  return diagrams.every((diagram) => {
    if (diagram.matches(".mermaid-loading")) {
      return false;
    }
    return Boolean(diagram.querySelector("svg"));
  });
}
