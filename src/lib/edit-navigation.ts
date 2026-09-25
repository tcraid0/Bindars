export type EditNavigationDecision =
  | "ignore"
  | "run"
  | "run-after-exit"
  | "confirm-discard";

interface EditNavigationState {
  editing: boolean;
  dirty: boolean;
  confirmDialogOpen: boolean;
  conflictDialogOpen: boolean;
}

export function decideEditNavigation({
  editing,
  dirty,
  confirmDialogOpen,
  conflictDialogOpen,
}: EditNavigationState): EditNavigationDecision {
  if (confirmDialogOpen || conflictDialogOpen) {
    return "ignore";
  }

  if (!editing) {
    return "run";
  }

  if (dirty) {
    return "confirm-discard";
  }

  return "run-after-exit";
}
