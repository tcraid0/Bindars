import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppError, ErrorCategory, FileRevision, FileType, OpenFileResult } from "../types";

type OpenRequestSource = "user" | "watcher";

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
  openFile: () => Promise<void>;
  openFilePath: (path: string, source?: OpenRequestSource) => Promise<boolean>;
  setVirtualContent: (text: string, name: string) => void;
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

  const dismissError = useCallback(() => setError(null), []);

  const fileType: FileType =
    filePath?.toLowerCase().endsWith(".fountain") ? "fountain" : "markdown";

  const openFilePath = useCallback(async (path: string, source: OpenRequestSource = "user"): Promise<boolean> => {
    if (source === "watcher" && userOpenInFlightRef.current) {
      return false;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    if (source === "user") {
      latestUserRequestIdRef.current = requestId;
      userOpenInFlightRef.current = true;
      setUserOpenInFlight(true);
      setOpeningPath(path);
    }

    try {
      const opened = await invoke<OpenFileResult>("open_markdown_file", { path });

      if (requestId !== requestIdRef.current) {
        return false;
      }

      setContent(opened.content);
      setFilePath(opened.canonicalPath);
      setFileName(opened.name);
      setFileRevision(opened.revision);
      return true;
    } catch (e) {
      if (requestId !== requestIdRef.current) {
        return false;
      }
      setError(categorizeError(e));
      return false;
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
      if (source === "user" && latestUserRequestIdRef.current === requestId) {
        latestUserRequestIdRef.current = null;
        userOpenInFlightRef.current = false;
        setUserOpenInFlight(false);
        setOpeningPath(null);
      }
    }
  }, []);

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

  const setVirtualContent = useCallback((text: string, name: string) => {
    setContent(text);
    setFilePath(null);
    setFileName(name);
    setFileRevision(null);
    setError(null);
    setLoading(false);
    latestUserRequestIdRef.current = null;
    userOpenInFlightRef.current = false;
    setUserOpenInFlight(false);
    setOpeningPath(null);
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
    userOpenInFlight,
    openFile,
    openFilePath,
    setVirtualContent,
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
