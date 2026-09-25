import type { FileType } from "../types";
import type { ParsedFountain } from "./fountain";
import type { ReadingStats } from "./reading-stats";
import type { DocumentComplexityOptions } from "./document-complexity";
import { assertDocumentComplexity, isDocumentComplexityError } from "./document-complexity";
import { parseFountain } from "./fountain";
import { computeReadingStats } from "./reading-stats";

export type PreparedReaderDocument =
  | {
      status: "ready";
      format: "markdown";
      readingStats: ReadingStats;
      parsedFountain: null;
    }
  | {
      status: "ready";
      format: "fountain";
      readingStats: ReadingStats;
      parsedFountain: ParsedFountain;
    }
  | {
      status: "too-complex";
      message: string;
    }
  | {
      status: "parse-failed";
      message: string;
    };

export const FOUNTAIN_PARSE_FAILED_MESSAGE =
  "This screenplay could not be parsed for display. You can still edit it.";

/** Validate and prepare all reader consumers once for a content revision. */
export function prepareReaderDocument(
  content: string,
  fileType: FileType,
  complexityOptions: DocumentComplexityOptions = {},
): PreparedReaderDocument {
  try {
    if (fileType === "fountain") {
      const parsedFountain = parseFountain(content, complexityOptions);
      return {
        status: "ready",
        format: "fountain",
        readingStats: computeReadingStats(content, fileType),
        parsedFountain,
      };
    }

    assertDocumentComplexity(content, "markdown", complexityOptions);
    return {
      status: "ready",
      format: "markdown",
      readingStats: computeReadingStats(content, fileType),
      parsedFountain: null,
    };
  } catch (error) {
    if (isDocumentComplexityError(error)) {
      return { status: "too-complex", message: error.message };
    }
    if (fileType === "fountain") {
      return { status: "parse-failed", message: describeParseFailure(error) };
    }
    throw error;
  }
}

function describeParseFailure(error: unknown): string {
  // fountain-js appends an issue-tracker plea on a second line; keep the first.
  const detail = error instanceof Error ? error.message.split("\n")[0].trim() : "";
  return detail ? `${FOUNTAIN_PARSE_FAILED_MESSAGE} (${detail})` : FOUNTAIN_PARSE_FAILED_MESSAGE;
}
