import {
  buildSearchCache,
  cachedDocuments,
  retainCachedDocuments,
} from "../lib/search-cache";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  RecentFile,
  WorkspaceDocIndex,
  WorkspaceFileMeta,
  WorkspaceState,
} from "../types";
import {
  discoveredDocument,
  failedCatalogDocument,
  isReusable,
  prepareCatalogDocument,
  sameFileVersion,
} from "../lib/document-catalog";
import { normalizeFileError } from "../lib/native-file-error";
import {
  fileName,
  isRelativeDocumentPath,
  relativeDocumentPath,
  toPathIdentityKey,
} from "../lib/paths";

const PUBLISH_INTERVAL_MS = 250;
const EMPTY: WorkspaceState = {
  rootPath: null,
  status: "idle",
  indexedAt: null,
  error: null,
  readFailedCount: 0,
  complexitySkippedCount: 0,
  limitHit: false,
};
interface Listing {
  canonicalRoot?: string | null;
  files: WorkspaceFileMeta[];
  directories?: string[];
  issues?: string[];
  limitHit: boolean;
  skipped?: boolean;
}
const EMPTY_LIST: Listing = { files: [], limitHit: false };

/** One catalog, three concrete sources. Discovery survives every text failure. */
export function useWorkspaceIndex(
  rootPath: string | null,
  recentFiles: RecentFile[] = [],
) {
  const [state, setState] = useState<WorkspaceState>(EMPTY);
  const [docs, setDocs] = useState<WorkspaceDocIndex[]>([]);
  const [refresh, setRefresh] = useState(0);
  const entries = useRef(new Map<string, WorkspaceDocIndex>());
  const runId = useRef(0);
  const saveVersion = useRef(0);
  const savedVersions = useRef(new Map<string, number>());
  // Validated entries retained within the disk cache's bounds, oldest evicted
  // first, so Add Back and a folder path that arrives after startup reuse
  // parsed text. Discovery must still confirm a candidate before publication.
  const known = useRef(new Map<string, WorkspaceDocIndex>());
  const cacheLoad = useRef<Promise<void> | null>(null);
  const listingCache = useRef<{
    root: string | null;
    refresh: number;
    folder: Listing;
    drafts: Listing;
  } | null>(null);
  const rootRef = useRef(rootPath);
  const publishedRoot = useRef(rootPath);
  const folderIdentity = useRef<{
    configured: string;
    canonical: string;
  } | null>(null);
  rootRef.current = rootPath;
  const recentPaths = JSON.stringify(recentFiles.map((f) => f.path).sort());
  const reindex = useCallback(() => setRefresh((n) => n + 1), []);
  // On macOS a launch listing skips the Drafts folder until a draft exists;
  // this lists it anyway, which may raise the Documents access prompt. Once
  // asked, every later run in the session lists too, so a denied folder keeps
  // showing its error through the focus recheck that follows the prompt.
  const forceDrafts = useRef(false);
  const showDrafts = useCallback(() => {
    forceDrafts.current = true;
    reindex();
  }, [reindex]);
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcile = useCallback(() => {
    if (reconcileTimer.current !== null) clearTimeout(reconcileTimer.current);
    reconcileTimer.current = setTimeout(() => {
      reconcileTimer.current = null;
      reindex();
    }, 100);
  }, [reindex]);
  useEffect(() => {
    // App's reconciliation lifecycle owns focus/resume signals.
    return () => {
      if (reconcileTimer.current !== null) clearTimeout(reconcileTimer.current);
    };
  }, []);

  const updateSaved = useCallback(
    (
      path: string,
      content: string,
      version: { size: number; mtimeMs: number },
      isDraft = false,
    ) => {
      saveVersion.current++;
      savedVersions.current.set(path, saveVersion.current);
      const previous = entries.current.get(path);
      const root = rootRef.current;
      const canonicalRoot =
        folderIdentity.current?.configured === root
          ? folderIdentity.current.canonical
          : root;
      const relativePath = canonicalRoot
        ? relativeDocumentPath(canonicalRoot, path)
        : null;
      // Discovery already proved membership. A save must not replace that valid
      // relative location just because the configured root uses an alias.
      const previousRelativePath =
        root &&
        publishedRoot.current === root &&
        previous?.sources?.includes("folder") &&
        isRelativeDocumentPath(previous.relPath)
          ? previous.relPath
          : null;
      const folderRelativePath = relativePath ?? previousRelativePath;
      const sources = new Set<NonNullable<WorkspaceFileMeta["sources"]>[number]>(
        previous?.sources?.filter((source) => source !== "folder"),
      );
      sources.add("recent");
      if (folderRelativePath !== null) sources.add("folder");
      if (isDraft) sources.add("draft");
      // Copy only the catalog's own fields: a FileRevision also carries a hash and folder id.
      const meta: WorkspaceFileMeta = {
        ...previous,
        path,
        name: fileName(path),
        size: version.size,
        mtimeMs: version.mtimeMs,
        relPath: folderRelativePath ?? previous?.relPath ?? fileName(path),
        sources: [...sources],
      };
      entries.current.set(path, prepareCatalogDocument(meta, content));
      const listing = listingCache.current;
      if (listing)
        for (const [source, list] of [
          ["folder", listing.folder],
          ["draft", listing.drafts],
        ] as const) {
          if (
            meta.sources?.includes(source) &&
            (source !== "folder" || listing.root === root)
          ) {
            list.files = [
              ...list.files.filter((file) => file.path !== path),
              meta,
            ];
          }
        }
      setDocs([...entries.current.values()]);
    },
    [],
  );

  const removeDocument = useCallback((path: string) => {
    savedVersions.current.set(path, ++saveVersion.current);
    entries.current.delete(path);
    if (listingCache.current) {
      listingCache.current.folder.files =
        listingCache.current.folder.files.filter((file) => file.path !== path);
      listingCache.current.drafts.files =
        listingCache.current.drafts.files.filter((file) => file.path !== path);
    }
    setDocs([...entries.current.values()]);
  }, []);

  useEffect(() => {
    const id = ++runId.current;
    let cancelled = false;
    const active = () => !cancelled && id === runId.current;
    const savedAtStart = saveVersion.current;
    const force = forceDrafts.current;
    const lastKnown = [...entries.current.values()];
    const candidates = new Map(entries.current);
    const paths = JSON.parse(recentPaths) as string[];
    // Retain the current folder during refresh, but immediately remove a
    // replaced folder's membership. Recent and Drafts have independent scope.
    const sameRoot = publishedRoot.current === rootPath;
    publishedRoot.current = rootPath;
    const keep = [...entries.current.values()]
      .filter(
        (doc) =>
          paths.includes(doc.path) ||
          doc.sources?.includes("draft") ||
          (sameRoot && doc.sources?.includes("folder")),
      )
      .map((doc) =>
        sameRoot
          ? doc
          : { ...doc, sources: doc.sources?.filter((s) => s !== "folder") },
      );
    entries.current = new Map(keep.map((doc) => [doc.path, doc]));
    setDocs(keep);
    // A recheck of the same folder keeps its subfolders and notices on screen
    // until the new listing replaces them.
    setState((prev) => ({
      ...(sameRoot ? prev : EMPTY),
      rootPath,
      status: "indexing",
      error: null,
      draftsError: null,
    }));
    const run = async () => {
      // The disposable cache is read once per session, as candidates only.
      cacheLoad.current ??= invoke<unknown>("load_search_cache")
        .then((cache) => {
          retainCachedDocuments(
            known.current,
            cachedDocuments(cache).filter((doc) => !known.current.has(doc.path)),
          );
        })
        .catch(() => {});
      await cacheLoad.current;
      if (!active()) return;
      for (const [path, doc] of known.current)
        if (!candidates.has(path)) candidates.set(path, doc);
      const priorListing =
        listingCache.current?.root === rootPath &&
        listingCache.current.refresh === refresh
          ? listingCache.current
          : null;
      const [folderResult, draftResult, recentResult] =
        await Promise.allSettled([
          priorListing
            ? Promise.resolve(priorListing.folder)
            : rootPath
              ? invoke<Listing>("list_workspace_markdown_files", {
                  root: rootPath,
                  maxFiles: 5_000,
                })
              : Promise.resolve(EMPTY_LIST),
          priorListing
            ? Promise.resolve(priorListing.drafts)
            : invoke<Listing>("list_draft_documents", { force }),
          invoke<WorkspaceFileMeta[]>("inspect_document_files", { paths }),
        ]);
      if (!active()) return;
      if (
        rootPath &&
        folderResult.status === "fulfilled" &&
        folderResult.value?.canonicalRoot
      ) {
        folderIdentity.current = {
          configured: rootPath,
          canonical: folderResult.value.canonicalRoot,
        };
      }
      const folder =
        folderResult.status === "fulfilled" && folderResult.value
          ? folderResult.value
          : {
              ...EMPTY_LIST,
              files: sameRoot
                ? lastKnown.filter((doc) => doc.sources?.includes("folder"))
                : [],
              directories:
                listingCache.current?.root === rootPath
                  ? listingCache.current.folder.directories
                  : [],
            };
      const drafts =
        draftResult.status === "fulfilled" && draftResult.value
          ? draftResult.value
          : {
              ...EMPTY_LIST,
              files: lastKnown.filter((doc) => doc.sources?.includes("draft")),
            };
      if (
        folderResult.status === "fulfilled" &&
        draftResult.status === "fulfilled"
      )
        listingCache.current = { root: rootPath, refresh, folder, drafts };
      const recent =
        recentResult.status === "fulfilled" && recentResult.value
          ? recentResult.value
          : [];
      const discovered = new Map<string, WorkspaceFileMeta>();
      const add = (
        files: WorkspaceFileMeta[],
        source: "folder" | "draft" | "recent",
      ) => {
        for (const meta of files) {
          const key = toPathIdentityKey(meta.path);
          const previous = discovered.get(key);
          discovered.set(key, {
            ...meta,
            relPath: previous?.relPath ?? meta.relPath,
            sources: [...new Set([...(previous?.sources ?? []), source])],
          });
        }
      };
      add(folder.files, "folder");
      add(drafts.files, "draft");
      add(recent, "recent");
      for (const path of paths)
        if (!discovered.has(toPathIdentityKey(path))) {
          add([{ path, name: fileName(path), relPath: path }], "recent");
        }
      for (const [path, doc] of entries.current)
        if ((savedVersions.current.get(path) ?? 0) > savedAtStart) {
          candidates.set(path, doc);
          for (const source of doc.sources ?? ["recent"]) add([doc], source);
        }
      const previous = candidates;
      const next = new Map<string, WorkspaceDocIndex>();
      const pending: WorkspaceFileMeta[] = [];
      for (const meta of discovered.values()) {
        if (
          (savedVersions.current.get(meta.path) ?? 0) > savedAtStart &&
          !entries.current.has(meta.path)
        )
          continue;
        const old = previous.get(meta.path);
        if (old && (savedVersions.current.get(meta.path) ?? 0) > savedAtStart)
          next.set(meta.path, {
            ...old,
            sources: meta.sources,
            relPath: meta.relPath,
          });
        else if (
          folderResult.status === "rejected" &&
          meta.sources?.includes("folder")
        )
          next.set(meta.path, failedCatalogDocument(meta, folderResult.reason));
        else if (
          draftResult.status === "rejected" &&
          meta.sources?.includes("draft")
        )
          next.set(meta.path, failedCatalogDocument(meta, draftResult.reason));
        else if (old && sameFileVersion(old, meta))
          // The same object when nothing changed, so the search's
          // per-document cache survives a window-focus recheck.
          next.set(
            meta.path,
            old.relPath === meta.relPath &&
              old.sources?.join() === meta.sources?.join()
              ? old
              : { ...old, ...meta },
          );
        else {
          next.set(meta.path, discoveredDocument(meta));
          pending.push(meta);
        }
      }
      entries.current = next;
      const base: WorkspaceState = {
        ...EMPTY,
        rootPath,
        status: "indexing",
        directories: folder.directories ?? [],
        issues: folder.issues ?? [],
        limitHit: folder.limitHit || drafts.limitHit,
        draftsSkipped: drafts.skipped ?? false,
        error:
          folderResult.status === "rejected"
            ? normalizeFileError(
                folderResult.reason,
                "Folder unavailable. Check its location and permissions, then retry.",
              ).message
            : null,
        draftsError:
          draftResult.status === "rejected"
            ? normalizeFileError(
                draftResult.reason,
                "Drafts unavailable. Retry after checking Documents access.",
              ).message
            : null,
      };
      setDocs([...next.values()]);
      setState(base);
      // One parse per turn bounds UI stalls. Every publication re-renders each
      // consumer, so publish on a time budget rather than per document.
      let publishedAt = Date.now();
      for (let i = 0; i < pending.length; i++) {
        if (!active()) return;
        const meta = pending[i];
        if (!next.has(meta.path)) continue;
        const saveBeforeRead = savedVersions.current.get(meta.path);
        let doc: WorkspaceDocIndex;
        try {
          const content = await invoke<string>("read_markdown_file", {
            path: meta.path,
          });
          if (!active()) return;
          doc = prepareCatalogDocument(meta, content);
        } catch (error) {
          doc = failedCatalogDocument(meta, error);
        }
        if (!active()) return;
        if (saveBeforeRead === savedVersions.current.get(meta.path))
          next.set(meta.path, doc);
        if (Date.now() - publishedAt >= PUBLISH_INTERVAL_MS) {
          setDocs([...next.values()]);
          publishedAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!active()) return;
      const published = [...next.values()];
      retainCachedDocuments(known.current, published.filter(isReusable));
      setDocs(published);
      setState({
        ...base,
        status: base.error ? "error" : "ready",
        indexedAt: Date.now(),
        readFailedCount: published.filter(
          (d) => d.problem && d.coverage !== "complexity",
        ).length,
        complexitySkippedCount: published.filter(
          (d) => d.coverage === "complexity",
        ).length,
      });
      // Bounded subset is fine: it is only a parse optimization, never the catalog.
      void invoke("save_search_cache", {
        cache: buildSearchCache(published),
      }).catch(() => {});
    };
    void run().catch((error) => {
      if (active())
        setState({ ...EMPTY, rootPath, status: "error", error: String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, recentPaths, refresh, reindex]);
  return {
    state,
    docs,
    reindex,
    reconcile,
    showDrafts,
    updateSaved,
    removeDocument,
  };
}
