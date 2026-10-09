import { invoke } from "@tauri-apps/api/core";
import { initializeAnnotationStorage } from "./annotation-storage";

// Settings are owned natively (src-tauri/src/settings.rs): every write is an
// atomic replacement of settings.json, so a resolved storeSet is on disk and a
// rejected one left the previous file intact. The native bootstrap seeds the
// cache from a checked read; nothing here can read or write before it succeeds.

export type StoreGetResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: unknown };

async function requireSettings(): Promise<void> {
  const status = await initializeAnnotationStorage();
  if (!status.settingsReady) throw new Error("Settings storage is unavailable. Existing data was preserved.");
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
    await requireSettings();
    const value = await invoke<T | null>("get_setting", { key });
    return { ok: true, value: value ?? null };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export async function storeSet<T>(key: string, value: T): Promise<boolean> {
  try {
    await requireSettings();
    await invoke("set_setting", { key, value });
    return true;
  } catch (e) {
    console.warn(`[store] Failed to set "${key}":`, e);
    return false;
  }
}
