let resolveReady: () => void;
export const appReadyPromise = new Promise<void>((r) => { resolveReady = r; });
export function signalAppReady(): void { resolveReady(); }
