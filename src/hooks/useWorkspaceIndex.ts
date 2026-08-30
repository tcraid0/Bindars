import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceDocIndex, WorkspaceFileMeta, WorkspaceState } from "../types";
import { DOCUMENT_COMPLEXITY_REASON } from "../lib/document-complexity";
import { normalizeFileError } from "../lib/native-file-error";
import { storeGet, storeSet } from "../lib/store";
import {
  buildWorkspaceRefreshErrorState,
  buildWorkspaceStateFromCache,
  LEGACY_WORKSPACE_INDEX_CACHE_KEYS,
  normalizeWorkspaceIndexCache,
  tryBuildWorkspaceDoc,
  type WorkspaceIndexCache,
  WORKSPACE_INDEX_CACHE_KEY,
  WORKSPACE_INDEX_CACHE_VERSION,
} from "../lib/workspace-index";

const MAX_WORKSPACE_FILES = 5_000;
const READ_BATCH_SIZE = 8;
const MAX_CACHE_TEXT_BYTES = 5_000_000;
const CACHE_FRESH_MS = 90_000;
const PROGRESS_UPDATE_INTERVAL_MS = 120;

const EMPTY_STATE: WorkspaceState = {
  rootPath: null,
  status: "idle",
  fileCount: 0,
  processedCount: 0,
  indexedCount: 0,
  indexedAt: null,
  error: null,
  listSkippedCount: 0,
  readFailedCount: 0,
  complexitySkippedCount: 0,
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
  const lastGoodStateRef = useRef<WorkspaceState | null>(null);

  const reindex = useCallback(() => {
    if (state.status === "indexing" || manualRefreshRef.current) return;
    manualRefreshRef.current = true;
    setRefreshNonce((v) => v + 1);
  }, [state.status]);

  useEffect(() => {
    if (!rootPath) {
      setState(EMPTY_STATE);
      setFiles([]);
      setDocs([]);
      lastGoodStateRef.current = null;
      return;
    }

    let active = true;
    const runId = ++runIdRef.current;
    const forceRefresh = manualRefreshRef.current;
    manualRefreshRef.current = false;
    const sameRootAsCurrent = state.rootPath === rootPath;

    if (!sameRootAsCurrent) {
      // Clear previous workspace data to avoid showing stale backlinks/mentions
      // while a different root is loading.
      setFiles([]);
      setDocs([]);
    }
    setState((prev) => ({
      rootPath,
      status: "indexing",
      fileCount: sameRootAsCurrent ? prev.fileCount : 0,
      processedCount: sameRootAsCurrent ? prev.processedCount : 0,
      indexedCount: sameRootAsCurrent ? prev.indexedCount : 0,
      indexedAt: sameRootAsCurrent ? prev.indexedAt : null,
      error: null,
      listSkippedCount: sameRootAsCurrent ? prev.listSkippedCount : 0,
      readFailedCount: sameRootAsCurrent ? prev.readFailedCount : 0,
      complexitySkippedCount: sameRootAsCurrent ? prev.complexitySkippedCount : 0,
      limitHit: sameRootAsCurrent ? prev.limitHit : false,
    }));

    const hydrateFromCache = async (): Promise<number | null> => {
      const cached = await storeGet<WorkspaceIndexCache>(WORKSPACE_INDEX_CACHE_KEY);
      if (!active || runId !== runIdRef.current || !cached) return null;
      if (cached.version !== WORKSPACE_INDEX_CACHE_VERSION || cached.rootPath !== rootPath) return null;
      const normalized = normalizeWorkspaceIndexCache(cached);
      const cachedState = buildWorkspaceStateFromCache(normalized, rootPath);

      setFiles(normalized.files);
      setDocs(normalized.docs);
      setState(cachedState);
      lastGoodStateRef.current = cachedState;
      return normalized.indexedAt;
    };

    const purgeLegacyCache = async (): Promise<void> => {
      for (const cacheKey of LEGACY_WORKSPACE_INDEX_CACHE_KEYS) {
        const legacyCache = await storeGet<unknown>(cacheKey);
        if (!active || runId !== runIdRef.current) return;
        if (legacyCache !== null) {
          await storeSet(cacheKey, null);
        }
      }
    };

    const clearLegacyCache = () => {
      for (const cacheKey of LEGACY_WORKSPACE_INDEX_CACHE_KEYS) {
        void storeSet(cacheKey, null);
      }
    };

    const reportRunError = (error: unknown) => {
      if (!active || runId !== runIdRef.current) return;

      clearLegacyCache();
      setState((prev) => {
        return buildWorkspaceRefreshErrorState(
          prev,
          lastGoodStateRef.current,
          rootPath,
          getErrorMessage(error),
        );
      });
    };

    const run = async () => {
      await purgeLegacyCache();
      if (!active || runId !== runIdRef.current) return;

      const cachedIndexedAt = forceRefresh ? null : await hydrateFromCache();
      if (!active || runId !== runIdRef.current) return;

      if (!forceRefresh && cachedIndexedAt && Date.now() - cachedIndexedAt < CACHE_FRESH_MS) {
        return;
      }

      setState((prev) => ({
        rootPath,
        status: "indexing",
        fileCount: prev.fileCount,
        processedCount: 0,
        indexedCount: 0,
        indexedAt: prev.indexedAt,
        error: null,
        listSkippedCount: prev.listSkippedCount,
        readFailedCount: 0,
        complexitySkippedCount: 0,
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
          processedCount: 0,
          indexedCount: prev.indexedCount,
          indexedAt: prev.indexedAt,
          error: null,
          listSkippedCount: listed.skippedCount,
          readFailedCount: 0,
          complexitySkippedCount: 0,
          limitHit: listed.limitHit,
        }));

        const nextDocs: WorkspaceDocIndex[] = [];
        let processedCount = 0;
        let readFailedCount = 0;
        let complexitySkippedCount = 0;
        let lastProgressUpdateAt = Date.now();

        for (let i = 0; i < listed.files.length; i += READ_BATCH_SIZE) {
          const batch = listed.files.slice(i, i + READ_BATCH_SIZE);
          const parsed = await Promise.all(
            batch.map(async (meta) => {
              let content: string;
              try {
                content = await invoke<string>("read_markdown_file", { path: meta.path });
              } catch (err) {
                console.warn(`[workspace-index] Failed to read ${meta.path}:`, err);
                return { doc: null, failure: "read" as const };
              }

              try {
                const result = tryBuildWorkspaceDoc(meta, content);
                if (result.status === "too-complex") {
                  console.warn(
                    `[workspace-index] Skipped document that is ${DOCUMENT_COMPLEXITY_REASON}: ${meta.path}.`,
                  );
                  return { doc: null, failure: "complexity" as const };
                }
                return { doc: result.doc, failure: null };
              } catch (err) {
                console.warn(`[workspace-index] Failed to index ${meta.path}:`, err);
                return { doc: null, failure: "read" as const };
              }
            }),
          );

          if (!active || runId !== runIdRef.current) return;

          for (const result of parsed) {
            if (result.doc) nextDocs.push(result.doc);
            if (result.failure === "read") readFailedCount += 1;
            if (result.failure === "complexity") complexitySkippedCount += 1;
          }

          processedCount += batch.length;
          const now = Date.now();
          const shouldUpdateProgress =
            now - lastProgressUpdateAt >= PROGRESS_UPDATE_INTERVAL_MS ||
            processedCount >= listed.files.length;
          if (shouldUpdateProgress) {
            setState((prev) => ({
              ...prev,
              rootPath,
              status: "indexing",
              fileCount: listed.files.length,
              processedCount: Math.min(processedCount, listed.files.length),
              indexedCount: nextDocs.length,
              error: null,
              readFailedCount,
              complexitySkippedCount,
            }));
            lastProgressUpdateAt = now;
          }

          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        if (!active || runId !== runIdRef.current) return;

        setDocs(nextDocs);
        const indexedAt = Date.now();
        const readyState: WorkspaceState = {
          rootPath,
          status: "ready",
          fileCount: listed.files.length,
          processedCount: listed.files.length,
          indexedCount: nextDocs.length,
          indexedAt,
          error: null,
          listSkippedCount: listed.skippedCount,
          readFailedCount,
          complexitySkippedCount,
          limitHit: listed.limitHit,
        };
        setState(readyState);
        lastGoodStateRef.current = readyState;

        if (estimateCacheTextSize(nextDocs) <= MAX_CACHE_TEXT_BYTES) {
          const cache: WorkspaceIndexCache = {
            version: WORKSPACE_INDEX_CACHE_VERSION,
            rootPath,
            indexedAt,
            files: listed.files,
            docs: nextDocs,
            processedCount: listed.files.length,
            readFailedCount,
            complexitySkippedCount,
            listSkippedCount: listed.skippedCount,
            limitHit: listed.limitHit,
          };
          void storeSet(WORKSPACE_INDEX_CACHE_KEY, cache);
          clearLegacyCache();
        } else {
          // Avoid inflating settings.json for very large workspaces.
          void storeSet(WORKSPACE_INDEX_CACHE_KEY, null);
          clearLegacyCache();
        }
      } catch (error) {
        reportRunError(error);
      }
    };

    void run().catch(reportRunError);

    return () => {
      active = false;
    };
  }, [rootPath, refreshNonce]);

  return { state, files, docs, reindex };
}

function getErrorMessage(error: unknown): string {
  return normalizeFileError(error, "Failed to build workspace index.").message;
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
