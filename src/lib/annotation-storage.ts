import { invoke } from "@tauri-apps/api/core";
import type { FileAnnotations } from "../types";

interface StorageStatus { settingsReady: boolean; settingsError: string | null }
let initialization: Promise<StorageStatus> | null = null;

export function initializeAnnotationStorage(): Promise<StorageStatus> {
  if (!initialization) {
    const pending = invoke<StorageStatus>("initialize_annotation_storage");
    initialization = pending;
    void pending.catch(() => {
      if (initialization === pending) initialization = null;
    });
  }
  return initialization;
}

export async function loadAnnotations(path: string): Promise<unknown> {
  // Annotations can remain available when only preferences are damaged.
  await initializeAnnotationStorage();
  return invoke("load_annotations", { path });
}

export async function saveAnnotations(path: string, annotations: FileAnnotations): Promise<void> {
  await invoke("save_annotations", { path, annotations });
}
