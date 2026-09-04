import { invoke } from "@tauri-apps/api/core";
import type { OpenFileResult } from "../types";
import { toPathIdentityKey } from "./paths";

// Provisional policy: tune these values only with measured packaged-app evidence.
export const DOCUMENT_OPEN_SLOW_MS = 2_000;
export const DOCUMENT_OPEN_TIMEOUT_MS = 30_000;
export const DOCUMENT_RECONCILIATION_TIMEOUT_MS = 10_000;

export interface StartedDocumentRead {
  readonly status: "started";
  readonly result: Promise<OpenFileResult>;
  readonly released: Promise<void>;
}

export interface PendingDocumentRead {
  readonly status: "pending";
  readonly result: Promise<OpenFileResult>;
  readonly released: Promise<void>;
}

export type DocumentRead = StartedDocumentRead | PendingDocumentRead;

type ReadDocument = (path: string) => Promise<OpenFileResult>;

export interface DocumentReadCoordinator {
  begin: (path: string) => DocumentRead;
}

export function documentReadPathKey(path: string): string {
  return toPathIdentityKey(path) || path;
}

export function createDocumentReadCoordinator(readDocument: ReadDocument): DocumentReadCoordinator {
  const unresolvedByPath = new Map<string, {
    readonly result: Promise<OpenFileResult>;
    readonly released: Promise<void>;
  }>();

  return {
    begin(path: string): DocumentRead {
      // This is requested-path normalization, not physical-file identity.
      // Symlink aliases can therefore use separate native reads by design.
      const pathKey = documentReadPathKey(path);
      const pending = unresolvedByPath.get(pathKey);
      if (pending) {
        return { status: "pending", ...pending };
      }

      const result = readDocument(path);
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      unresolvedByPath.set(pathKey, { result, released });

      const finish = () => {
        if (unresolvedByPath.get(pathKey)?.released === released) {
          unresolvedByPath.delete(pathKey);
        }
        release();
      };
      void result.then(finish, finish);

      return { status: "started", result, released };
    },
  };
}

const nativeDocumentReads = createDocumentReadCoordinator((path) => (
  invoke<OpenFileResult>("open_markdown_file", { path })
));

export function beginDocumentRead(path: string): DocumentRead {
  return nativeDocumentReads.begin(path);
}
