import type { FileType } from "../types";

interface EditEntryState {
  documentOpen: boolean;
  editing: boolean;
  loading: boolean;
}

interface PresentationEntryState extends EditEntryState {
  focusMode: boolean;
  fileType: FileType;
}

export function canEnterEditMode({
  documentOpen,
  editing,
  loading,
}: EditEntryState): boolean {
  return documentOpen && !editing && !loading;
}

export function canToggleEditMode(state: EditEntryState): boolean {
  return state.editing || canEnterEditMode(state);
}

export function canEnterPresentationMode({
  documentOpen,
  editing,
  loading,
  focusMode,
  fileType,
}: PresentationEntryState): boolean {
  return documentOpen && !editing && !loading && !focusMode && fileType !== "fountain";
}
