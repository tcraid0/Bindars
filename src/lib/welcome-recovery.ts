import type { AppError } from "../types";

export interface WelcomeRecovery {
  path: string;
  error: AppError;
  retryDisabled: boolean;
}

export function welcomeRecoveryMessage({ path, error }: WelcomeRecovery): { title: string; detail: string } {
  const name = path.split(/[/\\]/).pop() || path;
  switch (error.category) {
    case "not-found":
      return { title: "Couldn’t find " + name + ".", detail: "It may have been moved or renamed, or its drive may be disconnected." };
    case "permission-denied":
      return { title: "Couldn’t access " + name + ".", detail: "Check the file’s permissions, or use Open File to choose it again." };
    default:
      // Preserve actionable native errors, including a pending storage request.
      return { title: "Couldn’t open " + name + ".", detail: error.message };
  }
}
