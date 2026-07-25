export function trySetLocalStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // localStorage is a best-effort fallback in restricted storage environments.
  }
}
