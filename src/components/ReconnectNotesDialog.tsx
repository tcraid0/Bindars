import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { DialogFrame } from "./DialogFrame";
import { PathDetails } from "./PathDetails";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { FountainRenderer } from "./FountainRenderer";
import { prepareReaderDocument } from "../lib/document-processing";
import {
  prepareAnnotationDocument,
  resolveAnchor,
} from "../lib/text-anchoring";
import { readAnnotationRecord } from "../lib/annotation-record";
import { normalizeFileError } from "../lib/native-file-error";
import { loadAnnotations } from "../lib/annotation-storage";
import { fileName } from "../lib/paths";
import { documentFileType, OPENABLE_FILE_EXTENSIONS } from "../lib/openable-files";
import type { FileRevision, OpenFileResult, ReaderSettings } from "../types";
interface RecordSummary {
  path: string;
  highlights: number | null;
  notes: number | null;
  bookmarks: number | null;
}
export function ReconnectNotesDialog({
  sourcePath,
  settings,
  onClose,
  onReconnect,
  onOpen,
}: {
  sourcePath: string | null;
  settings: ReaderSettings;
  onClose: () => void;
  onReconnect: (
    source: string,
    destination: string,
    expected: unknown,
    revision: FileRevision,
  ) => Promise<void>;
  onOpen: (path: string) => void;
}) {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [source, setSource] = useState(sourcePath ?? "");
  const [expected, setExpected] = useState<unknown>(null);
  const [destination, setDestination] = useState<OpenFileResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    located: number;
    uncertain: number;
    missing: number;
    retained: number;
    bookmarks: number;
    totalBookmarks: number;
  } | null>(null);
  const [complete, setComplete] = useState(false);
  const previewRef = useRef<HTMLElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void invoke<RecordSummary[]>("list_annotation_documents")
      .then((result) => {
        if (alive.current)
          setRecords(result.sort((a, b) => a.path.localeCompare(b.path)));
      })
      .catch((error) =>
        setError(
          normalizeFileError(error, "Couldn't read saved notes.").message,
        ),
      );
    return () => {
      alive.current = false;
    };
  }, []);
  const prepared = useMemo(
    () =>
      destination
        ? prepareReaderDocument(
            destination.content,
            documentFileType(destination.name),
          )
        : null,
    [destination],
  );
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (
      !destination ||
      !expected ||
      prepared?.status !== "ready" ||
      !previewRef.current
    )
      return;
    const container = previewRef.current;
    void prepareAnnotationDocument(container, destination.content)
      .then((evidence) => {
        const record = readAnnotationRecord(expected);
        const states = record.annotations.highlights.map(
          (highlight) => resolveAnchor(highlight, container, evidence).status,
        );
        const ids = new Set(
          Array.from(container.querySelectorAll("[id]")).map(
            (element) => element.id,
          ),
        );
        if (active)
          setPreview({
            located: states.filter((s) => s === "located").length,
            uncertain: states.filter((s) => s === "uncertain").length,
            missing: states.filter((s) => s === "missing").length,
            retained:
              record.retainedHighlights.length +
              record.retainedBookmarks.length,
            bookmarks: record.annotations.bookmarks.filter((bookmark) =>
              ids.has(bookmark.headingId),
            ).length,
            totalBookmarks: record.annotations.bookmarks.length,
          });
      })
      .catch((error) => {
        if (active)
          setError(
            normalizeFileError(error, "Couldn't preview these notes.").message,
          );
      });
    return () => {
      active = false;
    };
  }, [destination, expected, prepared]);
  const choose = async () => {
    setError(null);
    setBusy(true);
    setPreview(null);
    setDestination(null);
    try {
      const path = await open({
        multiple: false,
        filters: [
          { name: "Documents", extensions: [...OPENABLE_FILE_EXTENSIONS] },
        ],
      });
      if (!path || Array.isArray(path) || !alive.current) return;
      const [doc, record] = await Promise.all([
        invoke<OpenFileResult>("open_markdown_file", { path }),
        source ? loadAnnotations(source) : Promise.resolve(null),
      ]);
      if (!alive.current) return;
      if (!record) {
        onClose();
        onOpen(doc.canonicalPath);
        return;
      }
      readAnnotationRecord(record); // Unsupported versions remain untouched.
      const target = await loadAnnotations(doc.canonicalPath);
      if (target) {
        const parsed = readAnnotationRecord(target);
        if (
          parsed.annotations.highlights.length ||
          parsed.annotations.bookmarks.length ||
          parsed.retainedHighlights.length ||
          parsed.retainedBookmarks.length
        )
          throw new Error(
            "The destination already has annotations. Choose another document; merging is not supported.",
          );
      }
      setExpected(record);
      setDestination(doc);
    } catch (error) {
      if (alive.current)
        setError(
          normalizeFileError(error, "Couldn't preview this destination.")
            .message,
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const commit = async () => {
    if (!destination || !preview) return;
    setBusy(true);
    setError(null);
    try {
      await onReconnect(
        source,
        destination.canonicalPath,
        expected,
        destination.revision,
      );
      if (alive.current) setComplete(true);
    } catch (error) {
      if (alive.current)
        setError(
          normalizeFileError(
            error,
            "Reconnection failed. Original records were preserved.",
          ).native?.detail ||
            normalizeFileError(
              error,
              "Reconnection failed. Original records were preserved.",
            ).message,
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <DialogFrame
      visible
      title="Find Notes · Reconnect a document"
      initialFocusRef={selectRef}
      onDismiss={() => {
        if (!busy) onClose();
      }}
      className="w-full max-w-xl mx-3 rounded-xl border border-border bg-bg-secondary p-5 max-h-[90vh] overflow-y-auto"
    >
      <p className="text-sm my-3">
        Choose the old document and its new location. Reconnecting moves its
        saved highlights, notes and bookmarks; it never changes either document.
      </p>
      <label className="text-sm block">
        Original document
        <select
          ref={selectRef}
          className="w-full p-2 border border-border my-2"
          value={source}
          disabled={busy || complete}
          onChange={(event) => {
            setSource(event.target.value);
            setDestination(null);
            setPreview(null);
          }}
        >
          <option value="">Choose saved notes…</option>
          {sourcePath &&
            !records.some((record) => record.path === sourcePath) && (
              <option value={sourcePath}>
                {sourcePath} · no saved notes found
              </option>
            )}
          {records.map((record) => (
            <option key={record.path} value={record.path}>
              {fileName(record.path)} · {record.highlights ?? "?"} highlights,{" "}
              {record.notes ?? "?"} notes, {record.bookmarks ?? "?"} bookmarks
            </option>
          ))}
        </select>
      </label>
      {source && <PathDetails key={source} path={source} />}
      {!complete && (
        <button
          className="navigation-action"
          onClick={() => void choose()}
          disabled={!source || busy}
        >
          Choose destination document…
        </button>
      )}
      {destination && (
        <div className="my-2">
          <p className="text-sm break-words">Destination: {destination.name}</p>
          <PathDetails
            key={destination.canonicalPath}
            path={destination.canonicalPath}
          />
        </div>
      )}
      {prepared && prepared.status !== "ready" && (
        <p role="status">
          This document cannot be displayed safely, so its passages cannot be
          previewed. Choose another destination.
        </p>
      )}
      {preview && !complete && (
        <>
          <p role="status" className="text-sm my-3">
            {preview.located} highlighted passages located; {preview.uncertain}{" "}
            uncertain; {preview.missing} missing. {preview.bookmarks} of{" "}
            {preview.totalBookmarks} bookmark headings found.
          </p>
          <p className="text-sm my-3">
            All records will be preserved, including unresolved passages
            {preview.retained
              ? ` and ${preview.retained} records that cannot be displayed`
              : ""}
            . Missing or uncertain passages will remain in your notes for
            review.
          </p>
          <p className="text-xs my-3">
            The preview uses the same conservative matching as your notes.
            Images and diagram content that has not rendered cannot be confirmed
            here.
          </p>
          <button
            className="navigation-action"
            disabled={busy}
            onClick={() => void commit()}
          >
            Reconnect these notes
          </button>
        </>
      )}
      {complete && (
        <p role="status">
          Notes reconnected.{" "}
          <button
            className="navigation-action"
            onClick={() => {
              onClose();
              onOpen(destination!.canonicalPath);
            }}
          >
            Open document
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm my-3">
          {error}
        </p>
      )}
      <button className="navigation-action" disabled={busy} onClick={onClose}>
        {complete ? "Done" : "Cancel"}
      </button>
      {/* Render with the reader's actual pipeline for conservative annotation evidence.
        Images remain unauthorized; unavailable dynamic diagrams are reported unresolved. */}
      {destination && prepared?.status === "ready" && (
        <div
          aria-hidden="true"
          inert
          style={{ position: "absolute", left: -100000, width: 700 }}
        >
          {prepared.parsedFountain ? (
            <FountainRenderer
              parsed={prepared.parsedFountain}
              settings={settings}
              contentRef={previewRef}
            />
          ) : (
            <MarkdownRenderer
              content={destination.content}
              filePath={destination.canonicalPath}
              imagesAuthorized={false}
              settings={settings}
              contentRef={previewRef}
              onOpenFragment={() => false}
            />
          )}
        </div>
      )}
    </DialogFrame>
  );
}
