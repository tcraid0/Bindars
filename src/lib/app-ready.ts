export const STARTUP_TIMEOUT_MS = 3000;

let resolveReady: () => void;
export const appReadyPromise = new Promise<void>((r) => { resolveReady = r; });
export function signalAppReady(): void { resolveReady(); }
