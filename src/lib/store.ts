import { load } from "@tauri-apps/plugin-store";

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
  if (!storePromise) {
    storePromise = load("settings.json", {
      defaults: {},
      autoSave: true,
    });
  }
  return storePromise;
}

export async function storeGet<T>(key: string): Promise<T | null> {
  try {
    const store = await getStore();
    const value = await store.get<T>(key);
    return value ?? null;
  } catch (e) {
    console.warn(`[store] Failed to get "${key}":`, e);
    return null;
  }
}

export async function storeKeys(): Promise<string[]> {
  try {
    const store = await getStore();
    return await store.keys();
  } catch (e) {
    console.warn("[store] Failed to list keys:", e);
    return [];
  }
}

export async function storeSet<T>(key: string, value: T): Promise<void> {
  try {
    const store = await getStore();
    await store.set(key, value);
  } catch (e) {
    console.warn(`[store] Failed to set "${key}":`, e);
  }
}
