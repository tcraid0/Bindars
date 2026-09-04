import type { AppError } from "../types";
import { boundOperation } from "./bounded-operation";
import {
  beginDocumentRead,
  DOCUMENT_RECONCILIATION_TIMEOUT_MS,
} from "./document-read";
import type { DocumentRead } from "./document-read";
import {
  reconciliationProbeFailure,
} from "./document-reconciliation";
import type { ReconciliationProbeResult } from "./document-reconciliation";
import { appErrorFromNative } from "./native-file-error";
import { toPathIdentityKey } from "./paths";

type BeginDocumentRead = (path: string) => DocumentRead;

const pendingReadError: AppError = {
  category: "resource-unavailable",
  message: "macOS is still waiting on an earlier request for this file. The current document remains open. If the request never finishes, quit and reopen Bindars.",
};

const reconciliationTimeoutError: AppError = {
  category: "resource-unavailable",
  message: "Checking this file timed out. The current document remains open; try again when the file is available. If the request never finishes, quit and reopen Bindars.",
};

export async function probeDocumentForReconciliation(
  path: string,
  beginRead: BeginDocumentRead = beginDocumentRead,
  timeoutMs = DOCUMENT_RECONCILIATION_TIMEOUT_MS,
): Promise<ReconciliationProbeResult> {
  const read = beginRead(path);
  if (read.status === "pending") {
    return {
      status: "unavailable",
      reason: "unavailable",
      error: pendingReadError,
    };
  }

  const outcome = await boundOperation(read.result, { timeoutMs }).result;
  switch (outcome.status) {
    case "fulfilled":
      return {
        status: "available",
        documentId: toPathIdentityKey(outcome.value.canonicalPath),
        document: outcome.value,
      };
    case "timed-out":
      return {
        status: "unavailable",
        reason: "timeout",
        error: reconciliationTimeoutError,
      };
    case "rejected":
      return reconciliationProbeFailure(
        appErrorFromNative(outcome.reason, "Bindars couldn't check the open document."),
      );
    case "cancelled":
      return {
        status: "unavailable",
        reason: "unavailable",
        error: {
          category: "resource-unavailable",
          message: "Bindars stopped checking this file. The current document remains open.",
        },
      };
  }
}
