import { load } from "@tauri-apps/plugin-store";

let storePromise: ReturnType<typeof load> | null = null;

export type StoreGetResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: unknown };

function getStore() {
  if (!storePromise) {
    const pendingStore = load("settings.json", {
      defaults: {},
      autoSave: true,
    });
    storePromise = pendingStore;
    pendingStore.catch(() => {
      if (storePromise === pendingStore) {
        storePromise = null;
      }
    });
  }
  return storePromise;
}

export async function storeGet<T>(key: string): Promise<T | null> {
  const result = await storeTryGet<T>(key);
  if (result.ok) {
    return result.value;
  }

  console.warn(`[store] Failed to get "${key}":`, result.error);
  return null;
}

export async function storeTryGet<T>(key: string): Promise<StoreGetResult<T>> {
  try {
    const store = await getStore();
    const value = await store.get<T>(key);
    return { ok: true, value: value ?? null };
  } catch (e) {
    return { ok: false, error: e };
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

export async function storeSet<T>(key: string, value: T): Promise<boolean> {
  try {
    const store = await getStore();
    await store.set(key, value);
    return true;
  } catch (e) {
    console.warn(`[store] Failed to set "${key}":`, e);
    return false;
  }
}
