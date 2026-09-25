import { MERMAID_RENDER_TIMEOUT_MS } from "../components/MermaidBlock";

export const PRINT_PREPARE_TIMEOUT_MS = MERMAID_RENDER_TIMEOUT_MS + 1_000;
export const PRINT_CLEANUP_TIMEOUT_MS = 30_000;
const PRINT_LAYOUT_SETTLE_FRAMES = 2;
const FRAME_FALLBACK_MS = 100;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

interface FontSetLike {
  ready: Promise<unknown>;
}

interface PrintImageLike {
  complete: boolean;
  loading?: string;
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
  cancelAnimationFrameFn?: typeof globalThis.cancelAnimationFrame;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}

interface PreparePrintDocumentOptions extends WaitOptions, FrameOptions {
  fonts?: FontSetLike | null;
  root?: QueryRootLike | null;
  settleFrames?: number;
}

export function createPrintCleanupController(
  cleanup: () => boolean | void,
  timeoutMs = PRINT_CLEANUP_TIMEOUT_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
) {
  let timeoutHandle: TimeoutHandle | null = null;
  const controller = {
    arm() {
      if (timeoutHandle !== null) {
        clearTimeoutFn(timeoutHandle);
      }
      timeoutHandle = setTimeoutFn(() => {
        timeoutHandle = null;
        controller.check();
      }, timeoutMs);
    },
    check() {
      // A checkpoint is not a maximum native dialog lifetime. Keep checking
      // if media or a queued native operation still owns the document.
      if (cleanup() === false) controller.arm();
      else controller.disarm();
    },
    disarm() {
      if (timeoutHandle === null) {
        return;
      }
      clearTimeoutFn(timeoutHandle);
      timeoutHandle = null;
    },
  };
  return controller;
}

export async function preparePrintDocument({
  fonts = typeof document !== "undefined" ? document.fonts : null,
  root,
  timeoutMs = PRINT_PREPARE_TIMEOUT_MS,
  requestAnimationFrameFn = globalThis.requestAnimationFrame,
  cancelAnimationFrameFn = globalThis.cancelAnimationFrame,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  settleFrames = PRINT_LAYOUT_SETTLE_FRAMES,
}: PreparePrintDocumentOptions): Promise<void> {
  const frameOptions = { requestAnimationFrameFn, cancelAnimationFrameFn, setTimeoutFn, clearTimeoutFn };
  await waitForAnimationFrames(settleFrames, frameOptions);

  await Promise.all([
    waitForFonts(fonts, { timeoutMs, setTimeoutFn, clearTimeoutFn }),
    waitForImages(getImages(root), { timeoutMs, setTimeoutFn, clearTimeoutFn }),
    waitForMermaidDiagrams(root, { timeoutMs, ...frameOptions }),
  ]);

  await waitForAnimationFrames(1, frameOptions);
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
  // Waiting alone does not start offscreen lazy images. Restore the loading
  // preference afterward; already-started requests can finish normally.
  const lazyImages = images.filter((image) => image.loading === "lazy");
  for (const image of lazyImages) image.loading = "eager";
  const pending = images.filter((image) => !image.complete);
  try {
    // Each image has its own deadline and removes its event listeners.
    await Promise.allSettled(
      pending.map((image) => waitForImage(image, timeoutMs, setTimeoutFn, clearTimeoutFn)),
    );
  } finally {
    for (const image of lazyImages) image.loading = "lazy";
  }
}

export async function waitForMermaidDiagrams(
  root: QueryRootLike | null | undefined,
  {
    timeoutMs = PRINT_PREPARE_TIMEOUT_MS,
    requestAnimationFrameFn = globalThis.requestAnimationFrame,
    cancelAnimationFrameFn = globalThis.cancelAnimationFrame,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  }: WaitOptions & FrameOptions = {},
): Promise<void> {
  if (!root || mermaidDiagramsReady(root)) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitForAnimationFrames(1, { requestAnimationFrameFn, cancelAnimationFrameFn, setTimeoutFn, clearTimeoutFn });
    if (mermaidDiagramsReady(root)) {
      return;
    }
  }
}

export async function waitForAnimationFrames(
  frameCount: number,
  {
    requestAnimationFrameFn = globalThis.requestAnimationFrame,
    cancelAnimationFrameFn = globalThis.cancelAnimationFrame,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  }: FrameOptions = {},
): Promise<void> {
  if (frameCount <= 0) {
    return;
  }

  for (let remaining = frameCount; remaining > 0; remaining -= 1) {
    await new Promise<void>((resolve) => {
      let frameHandle: number | null = null;
      const finish = () => {
        clearTimeoutFn(timeoutHandle);
        if (frameHandle !== null) cancelAnimationFrameFn?.(frameHandle);
        resolve();
      };
      // Hidden webviews can suspend animation frames. Resource preparation
      // must still reach its deadlines and release queued frame callbacks.
      const timeoutHandle = setTimeoutFn(finish, FRAME_FALLBACK_MS);
      if (typeof requestAnimationFrameFn === "function") {
        frameHandle = requestAnimationFrameFn(finish);
      }
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
