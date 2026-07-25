import { invoke } from "@tauri-apps/api/core";

export type FileSnapshotDocument = { kind: "file"; path: string; name: string };
export type DraftSnapshotDocument = { kind: "draft"; id: string; name: string };
export type SnapshotDocument = FileSnapshotDocument | DraftSnapshotDocument;

export interface SnapshotEntry {
  id: string;
  createdAtMs: number;
  size: number;
}

export interface SnapshotDraft {
  id: string;
  name: string;
  latestSnapshotAtMs: number;
  snapshotCount: number;
}

export interface SnapshotDraftList {
  drafts: SnapshotDraft[];
  skippedCount: number;
}

export interface SnapshotStorageStats {
  streamCount: number;
  snapshotCount: number;
  totalBytes: number;
  skippedCount: number;
}

export interface SnapshotWriteResult {
  snapshot: SnapshotEntry;
  merged: boolean;
  unchanged: boolean;
}

export function fileSnapshotDocument(path: string, name: string): FileSnapshotDocument {
  return { kind: "file", path, name };
}

export function draftSnapshotDocument(id: string, name: string): DraftSnapshotDocument {
  return { kind: "draft", id, name };
}

export function createDraftSnapshotId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;

  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2);
  return `${time}-${random}`;
}

export async function writeDocumentSnapshot(
  document: SnapshotDocument,
  content: string,
  options?: { preservePrevious?: boolean },
): Promise<SnapshotWriteResult> {
  return invoke<SnapshotWriteResult>("write_document_snapshot", {
    document,
    content,
    preservePrevious: options?.preservePrevious ?? false,
  });
}

export async function listDocumentSnapshots(
  document: SnapshotDocument,
): Promise<SnapshotEntry[]> {
  return invoke<SnapshotEntry[]>("list_document_snapshots", { document });
}

export async function readDocumentSnapshot(
  document: SnapshotDocument,
  snapshotId: string,
): Promise<string> {
  return invoke<string>("read_document_snapshot", { document, snapshotId });
}

export async function listSnapshotDrafts(): Promise<SnapshotDraftList> {
  return invoke<SnapshotDraftList>("list_snapshot_drafts");
}

export async function getSnapshotStorageStats(): Promise<SnapshotStorageStats> {
  return invoke<SnapshotStorageStats>("get_snapshot_storage_stats");
}

export async function retireSnapshotDraft(document: DraftSnapshotDocument): Promise<void> {
  await invoke("retire_snapshot_draft", { document });
}

export async function clearSnapshotHistory(): Promise<void> {
  await invoke("clear_snapshot_history");
}
