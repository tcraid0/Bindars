import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppError, FileRevision, FileType, OpenFileResult } from "../types";
import type { SavedFileSnapshot } from "../lib/editor-save";
import { OPENABLE_FILE_EXTENSIONS } from "../lib/openable-files";
import { appErrorFromNative } from "../lib/native-file-error";

export type OpenFilePathResult =
  | { status: "opened"; canonicalPath: string }
  | { status: "failed"; error: AppError }
  | { status: "superseded" };

export interface PublishedDocument {
  readonly content: string | null;
  readonly filePath: string | null;
  readonly fileName: string | null;
  readonly fileRevision: FileRevision | null;
}

export interface OpenOwnership {
  readonly generation: number;
  readonly userOpenInFlight: boolean;
}

function publishedFileDocument(file: OpenFileResult | SavedFileSnapshot): PublishedDocument {
  return {
    content: file.content,
    filePath: file.canonicalPath,
    fileName: file.name,
    fileRevision: file.revision,
  };
}

interface UseMarkdownFileReturn {
  content: string | null;
  filePath: string | null;
  fileName: string | null;
  fileRevision: FileRevision | null;
  fileType: FileType;
  error: AppError | null;
  loading: boolean;
  openingPath: string | null;
  getPublishedDocument: () => PublishedDocument;
  getOpenOwnership: () => OpenOwnership;
  openFile: () => Promise<void>;
  openFilePath: (path: string) => Promise<boolean>;
  openFilePathWithStatus: (path: string) => Promise<OpenFilePathResult>;
  setVirtualContent: (text: string, name: string) => void;
  adoptSavedFile: (file: SavedFileSnapshot) => void;
  adoptReconciledDocument: (document: OpenFileResult) => void;
  refreshReconciledRevision: (revision: FileRevision) => void;
  reportReconciliationError: (error: AppError) => void;
  clearReconciliationError: () => void;
  supersedePendingOpen: () => void;
  dismissError: () => void;
}

export function useMarkdownFile(): UseMarkdownFileReturn {
  const [content, setContent] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileRevision, setFileRevision] = useState<FileRevision | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const userOpenInFlightRef = useRef(false);
  const activeRequestRef = useRef<number | null>(null);
  const publishedDocumentRef = useRef<PublishedDocument>({
    content: null,
    filePath: null,
    fileName: null,
    fileRevision: null,
  });
  const reconciliationErrorRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const dismissError = useCallback(() => {
    reconciliationErrorRef.current = false;
    setError(null);
  }, []);

  const resetOpenTracking = useCallback(() => {
    activeRequestRef.current = null;
    userOpenInFlightRef.current = false;
    setLoading(false);
    setOpeningPath(null);
  }, []);

  // Always replace this object: reader restore compares its identity as a
  // generation token, including before React commits the corresponding state.
  const publishDocument = useCallback((document: PublishedDocument) => {
    publishedDocumentRef.current = document;
    reconciliationErrorRef.current = false;
    setContent(document.content);
    setFilePath(document.filePath);
    setFileName(document.fileName);
    setFileRevision(document.fileRevision);
    setError(null);
  }, []);

  const getPublishedDocument = useCallback(() => publishedDocumentRef.current, []);
  const getOpenOwnership = useCallback((): OpenOwnership => ({
    generation: requestIdRef.current,
    userOpenInFlight: userOpenInFlightRef.current,
  }), []);

  const supersedePendingOpen = useCallback(() => {
    if (activeRequestRef.current !== null) {
      requestIdRef.current += 1;
      resetOpenTracking();
    }
  }, [resetOpenTracking]);

  const fileType: FileType =
    filePath?.toLowerCase().endsWith(".fountain") ? "fountain" : "markdown";

  const openFilePathWithStatus = useCallback(async (
    path: string,
  ): Promise<OpenFilePathResult> => {
    const requestId = ++requestIdRef.current;
    activeRequestRef.current = requestId;
    setLoading(true);
    setError(null);
    reconciliationErrorRef.current = false;
    userOpenInFlightRef.current = true;
    setOpeningPath(path);

    try {
      const opened = await invoke<OpenFileResult>("open_markdown_file", { path });

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return { status: "superseded" };
      }

      publishDocument(publishedFileDocument(opened));
      return { status: "opened", canonicalPath: opened.canonicalPath };
    } catch (e) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return { status: "superseded" };
      }
      const appError = appErrorFromNative(e, "Failed to open file.");
      reconciliationErrorRef.current = false;
      setError(appError);
      return { status: "failed", error: appError };
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        userOpenInFlightRef.current = false;
        if (mountedRef.current) {
          setLoading(false);
          setOpeningPath(null);
        }
      }
    }
  }, [publishDocument]);

  const openFilePath = useCallback(async (path: string): Promise<boolean> => {
    return (await openFilePathWithStatus(path)).status === "opened";
  }, [openFilePathWithStatus]);

  const openFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Supported Files",
            extensions: [...OPENABLE_FILE_EXTENSIONS],
          },
        ],
      });

      if (selected) {
        await openFilePath(selected);
      }
    } catch (e) {
      setError(appErrorFromNative(e, "Failed to open file."));
    }
  }, [openFilePath]);

  const setVirtualContent = useCallback((text: string, name: string) => {
    requestIdRef.current += 1;
    publishDocument({ content: text, filePath: null, fileName: name, fileRevision: null });
    resetOpenTracking();
  }, [publishDocument, resetOpenTracking]);

  const adoptSavedFile = useCallback((file: SavedFileSnapshot) => {
    requestIdRef.current += 1;
    publishDocument(publishedFileDocument(file));
    resetOpenTracking();
  }, [publishDocument, resetOpenTracking]);

  const adoptReconciledDocument = useCallback((document: OpenFileResult) => {
    requestIdRef.current += 1;
    activeRequestRef.current = null;
    publishDocument(publishedFileDocument(document));
  }, [publishDocument]);

  const refreshReconciledRevision = useCallback((revision: FileRevision) => {
    requestIdRef.current += 1;
    activeRequestRef.current = null;
    const current = publishedDocumentRef.current;
    const refreshed = { ...current, fileRevision: revision };
    publishedDocumentRef.current = refreshed;
    reconciliationErrorRef.current = false;
    setFileRevision(revision);
    setError(null);
  }, []);

  const reportReconciliationError = useCallback((reconciliationError: AppError) => {
    reconciliationErrorRef.current = true;
    setError(reconciliationError);
  }, []);

  const clearReconciliationError = useCallback(() => {
    if (!reconciliationErrorRef.current) return;
    reconciliationErrorRef.current = false;
    setError(null);
  }, []);

  return {
    content,
    filePath,
    fileName,
    fileRevision,
    fileType,
    error,
    loading,
    openingPath,
    getPublishedDocument,
    getOpenOwnership,
    openFile,
    openFilePath,
    openFilePathWithStatus,
    setVirtualContent,
    adoptSavedFile,
    adoptReconciledDocument,
    refreshReconciledRevision,
    reportReconciliationError,
    clearReconciliationError,
    supersedePendingOpen,
    dismissError,
  };
}
