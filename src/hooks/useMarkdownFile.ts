import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppError, ErrorCategory, FileRevision, FileType, OpenFileResult } from "../types";
import type { SavedFileSnapshot } from "../lib/editor-save";

export type OpenRequestSource = "user" | "watcher" | "reconcile";
export type OpenFilePathResult =
  | { status: "opened"; canonicalPath: string; contentChanged: boolean }
  | { status: "failed"; error: AppError }
  | { status: "superseded" };

export interface PublishedDocument {
  readonly content: string | null;
  readonly filePath: string | null;
  readonly fileName: string | null;
  readonly fileRevision: FileRevision | null;
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
  userOpenInFlight: boolean;
  getPublishedDocument: () => PublishedDocument;
  openFile: () => Promise<void>;
  openFilePath: (path: string, source?: OpenRequestSource) => Promise<boolean>;
  openFilePathWithStatus: (path: string, source?: OpenRequestSource) => Promise<OpenFilePathResult>;
  closeFile: () => void;
  setVirtualContent: (text: string, name: string) => void;
  adoptSavedFile: (file: SavedFileSnapshot) => void;
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
  const [userOpenInFlight, setUserOpenInFlight] = useState(false);
  const requestIdRef = useRef(0);
  const latestUserRequestIdRef = useRef<number | null>(null);
  const userOpenInFlightRef = useRef(false);
  const visibleRequestIdRef = useRef<number | null>(null);
  const activeRequestRef = useRef<{ id: number; source: OpenRequestSource } | null>(null);
  const publishedDocumentRef = useRef<PublishedDocument>({
    content: null,
    filePath: null,
    fileName: null,
    fileRevision: null,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  const resetOpenTracking = useCallback(() => {
    visibleRequestIdRef.current = null;
    setLoading(false);
    latestUserRequestIdRef.current = null;
    userOpenInFlightRef.current = false;
    setUserOpenInFlight(false);
    setOpeningPath(null);
  }, []);

  // Always replace this object: reader restore compares its identity as a
  // generation token, including before React commits the corresponding state.
  const publishDocument = useCallback((document: PublishedDocument) => {
    publishedDocumentRef.current = document;
    setContent(document.content);
    setFilePath(document.filePath);
    setFileName(document.fileName);
    setFileRevision(document.fileRevision);
    setError(null);
  }, []);

  const getPublishedDocument = useCallback(() => publishedDocumentRef.current, []);

  const supersedePendingOpen = useCallback(() => {
    if (activeRequestRef.current) {
      requestIdRef.current += 1;
      activeRequestRef.current = null;
    }
    if (visibleRequestIdRef.current !== null || userOpenInFlightRef.current) {
      resetOpenTracking();
    }
  }, [resetOpenTracking]);

  const fileType: FileType =
    filePath?.toLowerCase().endsWith(".fountain") ? "fountain" : "markdown";

  const openFilePathWithStatus = useCallback(async (
    path: string,
    source: OpenRequestSource = "user",
  ): Promise<OpenFilePathResult> => {
    if (source !== "user" && userOpenInFlightRef.current) {
      return { status: "superseded" };
    }

    const requestId = ++requestIdRef.current;
    activeRequestRef.current = { id: requestId, source };
    const visibleOpen = source !== "reconcile";
    if (visibleOpen) {
      visibleRequestIdRef.current = requestId;
      setLoading(true);
    }
    setError(null);
    if (source === "user") {
      latestUserRequestIdRef.current = requestId;
      userOpenInFlightRef.current = true;
      setUserOpenInFlight(true);
      setOpeningPath(path);
    }

    try {
      const opened = await invoke<OpenFileResult>("open_markdown_file", { path });

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return { status: "superseded" };
      }

      const contentChanged = opened.content !== publishedDocumentRef.current.content;
      publishDocument({
        content: opened.content,
        filePath: opened.canonicalPath,
        fileName: opened.name,
        fileRevision: opened.revision,
      });
      return { status: "opened", canonicalPath: opened.canonicalPath, contentChanged };
    } catch (e) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return { status: "superseded" };
      }
      const appError = categorizeError(e);
      setError(appError);
      return { status: "failed", error: appError };
    } finally {
      if (activeRequestRef.current?.id === requestId) activeRequestRef.current = null;
      if (visibleOpen && visibleRequestIdRef.current === requestId) {
        visibleRequestIdRef.current = null;
        if (mountedRef.current) {
          setLoading(false);
        }
      }
      if (source === "user" && latestUserRequestIdRef.current === requestId) {
        latestUserRequestIdRef.current = null;
        userOpenInFlightRef.current = false;
        if (mountedRef.current) {
          setUserOpenInFlight(false);
          setOpeningPath(null);
        }
      }
    }
  }, [publishDocument]);

  const openFilePath = useCallback(async (
    path: string,
    source: OpenRequestSource = "user",
  ): Promise<boolean> => {
    return (await openFilePathWithStatus(path, source)).status === "opened";
  }, [openFilePathWithStatus]);

  const openFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Supported Files",
            extensions: ["md", "markdown", "fountain"],
          },
        ],
      });

      if (selected) {
        await openFilePath(selected, "user");
      }
    } catch (e) {
      setError(categorizeError(e));
    }
  }, [openFilePath]);

  const closeFile = useCallback(() => {
    requestIdRef.current += 1;
    publishDocument({ content: null, filePath: null, fileName: null, fileRevision: null });
    resetOpenTracking();
  }, [publishDocument, resetOpenTracking]);

  const setVirtualContent = useCallback((text: string, name: string) => {
    requestIdRef.current += 1;
    publishDocument({ content: text, filePath: null, fileName: name, fileRevision: null });
    resetOpenTracking();
  }, [publishDocument, resetOpenTracking]);

  const adoptSavedFile = useCallback((file: SavedFileSnapshot) => {
    requestIdRef.current += 1;
    publishDocument({
      content: file.content,
      filePath: file.canonicalPath,
      fileName: file.name,
      fileRevision: file.revision,
    });
    resetOpenTracking();
  }, [publishDocument, resetOpenTracking]);

  return {
    content,
    filePath,
    fileName,
    fileRevision,
    fileType,
    error,
    loading,
    openingPath,
    userOpenInFlight,
    getPublishedDocument,
    openFile,
    openFilePath,
    openFilePathWithStatus,
    closeFile,
    setVirtualContent,
    adoptSavedFile,
    supersedePendingOpen,
    dismissError,
  };
}

function categorizeError(error: unknown): AppError {
  const message = getErrorMessage(error);
  return { message, category: categorizeMessage(message) };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Failed to open file.";
}

function categorizeMessage(message: string): ErrorCategory {
  if (message.includes("File not found")) return "not-found";
  if (message.includes("too large")) return "too-large";
  if (message.includes("Not a supported file type")) return "not-markdown";
  if (message.includes("UTF-8")) return "utf8";
  return "generic";
}
