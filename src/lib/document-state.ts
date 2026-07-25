import type { AppError } from "../types";

export function isDocumentOpen(content: string | null): content is string {
  return content !== null;
}

export function shouldCloseDocumentAfterOpenFailure(error: AppError): boolean {
  return error.category === "not-found";
}
