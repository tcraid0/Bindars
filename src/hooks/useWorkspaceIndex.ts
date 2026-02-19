import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceDocIndex, WorkspaceFileMeta, WorkspaceState } from "../types";
import { storeGet, storeSet } from "../lib/store";
import { buildWorkspaceDoc, type WorkspaceIndexCache } from "../lib/workspace-index";

const CACHE_KEY = "workspace:index:v1";
const MAX_WORKSPACE_FILES = 5_000;
const READ_BATCH_SIZE = 8;
const MAX_CACHE_TEXT_BYTES = 5_000_000;
const CACHE_FRESH_MS = 90_000;
const PROGRESS_UPDATE_INTERVAL_MS = 120;

const EMPTY_STATE: WorkspaceState = {
  rootPath: null,
  status: "idle",
  fileCount: 0,
  indexedCount: 0,
  indexedAt: null,
  error: null,
  listSkippedCount: 0,
  readFailedCount: 0,
  limitHit: false,
};

interface UseWorkspaceIndexResult {
  state: WorkspaceState;
  files: WorkspaceFileMeta[];
  docs: WorkspaceDocIndex[];
  reindex: () => void;
}

interface WorkspaceListResult {
  files: WorkspaceFileMeta[];
  skippedCount: number;
  limitHit: boolean;
}

export function useWorkspaceIndex(rootPath: string | null): UseWorkspaceIndexResult {
  const [state, setState] = useState<WorkspaceState>(EMPTY_STATE);
  const [files, setFiles] = useState<WorkspaceFileMeta[]>([]);
  const [docs, setDocs] = useState<WorkspaceDocIndex[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const runIdRef = useRef(0);
  const manualRefreshRef = useRef(false);

  const reindex = useCallback(() => {
    manualRefreshRef.current = true;
    setRefreshNonce((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!rootPath) {
      setState(EMPTY_STATE);
      setFiles([]);
      setDocs([]);
      return;
    }

    let active = true;
    const runId = ++runIdRef.current;
    const forceRefresh = manualRefreshRef.current;
    manualRefreshRef.current = false;

    // Clear previous workspace data to avoid showing stale backlinks/mentions
    // while a different root is loading.
    setFiles([]);
    setDocs([]);
    setState({
      rootPath,
      status: "indexing",
      fileCount: 0,
      indexedCount: 0,
      indexedAt: null,
      error: null,
      listSkippedCount: 0,
      readFailedCount: 0,
      limitHit: false,
    });

    const hydrateFromCache = async (): Promise<number | null> => {
      const cached = await storeGet<WorkspaceIndexCache>(CACHE_KEY);
      if (!active || runId !== runIdRef.current || !cached) return null;
      if (cached.version !== 1 || cached.rootPath !== rootPath) return null;

      setFiles(cached.files);
      setDocs(cached.docs);
      setState({
        rootPath,
        status: "ready",
        fileCount: cached.files.length,
        indexedCount: cached.docs.length,
        indexedAt: cached.indexedAt,
        error: null,
        listSkippedCount: 0,
        readFailedCount: 0,
        limitHit: false,
      });
      return cached.indexedAt;
    };

    const run = async () => {
      const cachedIndexedAt = await hydrateFromCache();
      if (!active || runId !== runIdRef.current) return;

      if (!forceRefresh && cachedIndexedAt && Date.now() - cachedIndexedAt < CACHE_FRESH_MS) {
        return;
      }

      setState((prev) => ({
        rootPath,
        status: "indexing",
        fileCount: prev.fileCount,
        indexedCount: 0,
        indexedAt: prev.indexedAt,
        error: null,
        listSkippedCount: prev.listSkippedCount,
        readFailedCount: 0,
        limitHit: prev.limitHit,
      }));

      try {
        const listed = await invoke<WorkspaceListResult>("list_workspace_markdown_files", {
          root: rootPath,
          maxFiles: MAX_WORKSPACE_FILES,
        });
        if (!active || runId !== runIdRef.current) return;

        setFiles(listed.files);
        setState((prev) => ({
          rootPath,
          status: "indexing",
          fileCount: listed.files.length,
          indexedCount: prev.indexedCount,
          indexedAt: prev.indexedAt,
          error: null,
          listSkippedCount: listed.skippedCount,
          readFailedCount: 0,
          limitHit: listed.limitHit,
        }));

        const nextDocs: WorkspaceDocIndex[] = [];
        let indexedCount = 0;
        let readFailedCount = 0;
        let lastProgressUpdateAt = Date.now();

        for (let i = 0; i < listed.files.length; i += READ_BATCH_SIZE) {
          const batch = listed.files.slice(i, i + READ_BATCH_SIZE);
          const parsed = await Promise.all(
            batch.map(async (meta) => {
              try {
                const content = await invoke<string>("read_markdown_file", { path: meta.path });
                return { doc: buildWorkspaceDoc(meta, content), failed: false as const };
              } catch (err) {
                console.warn(`[workspace-index] Failed to read ${meta.path}:`, err);
                return { doc: null, failed: true as const };
              }
            }),
          );

          if (!active || runId !== runIdRef.current) return;

          for (const result of parsed) {
            if (result.doc) nextDocs.push(result.doc);
            if (result.failed) readFailedCount += 1;
          }

          indexedCount += batch.length;
          const now = Date.now();
          const shouldUpdateProgress =
            now - lastProgressUpdateAt >= PROGRESS_UPDATE_INTERVAL_MS ||
            indexedCount >= listed.files.length;
          if (shouldUpdateProgress) {
            setState((prev) => ({
              ...prev,
              rootPath,
              status: "indexing",
              fileCount: listed.files.length,
              indexedCount: Math.min(indexedCount, listed.files.length),
              error: null,
              readFailedCount,
            }));
            lastProgressUpdateAt = now;
          }

          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        if (!active || runId !== runIdRef.current) return;

        setDocs(nextDocs);
        const indexedAt = Date.now();
        setState({
          rootPath,
          status: "ready",
          fileCount: listed.files.length,
          indexedCount: nextDocs.length,
          indexedAt,
          error: null,
          listSkippedCount: listed.skippedCount,
          readFailedCount,
          limitHit: listed.limitHit,
        });

        if (estimateCacheTextSize(nextDocs) <= MAX_CACHE_TEXT_BYTES) {
          const cache: WorkspaceIndexCache = {
            version: 1,
            rootPath,
            indexedAt,
            files: listed.files,
            docs: nextDocs,
          };
          void storeSet(CACHE_KEY, cache);
        } else {
          // Avoid inflating settings.json for very large workspaces.
          void storeSet(CACHE_KEY, null);
        }
      } catch (err) {
        if (!active || runId !== runIdRef.current) return;

        setDocs([]);
        setFiles([]);
        void storeSet(CACHE_KEY, null);
        setState({
          rootPath,
          status: "error",
          fileCount: 0,
          indexedCount: 0,
          indexedAt: null,
          error: getErrorMessage(err),
          listSkippedCount: 0,
          readFailedCount: 0,
          limitHit: false,
        });
      }
    };

    void run();

    return () => {
      active = false;
    };
  }, [rootPath, refreshNonce]);

  return { state, files, docs, reindex };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "Failed to build workspace index.";
}

function estimateCacheTextSize(docs: WorkspaceDocIndex[]): number {
  let size = 0;
  for (const doc of docs) {
    size += doc.bodyText.length;
    size += doc.title?.length ?? 0;
    size += doc.relPath.length + doc.name.length;
    for (const heading of doc.headings) {
      size += heading.text.length + heading.id.length;
    }
  }
  return size;
}
