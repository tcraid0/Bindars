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
    };

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
    throw error;
  }
}
