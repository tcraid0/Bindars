export type Theme = "light" | "sepia" | "dark" | "deep-dark";
export type FileType = "markdown" | "fountain";

export interface HeadingItem {
  id: string;
  text: string;
  level: number;
}

export type FontFamily =
  | "newsreader"
  | "source-sans-3"
  | "dm-sans"
  | "roboto-slab"
  | "atkinson"
  | "opendyslexic";
export type ParagraphSpacing = "compact" | "comfortable" | "spacious";
export type PrintLayout = "standard" | "book";

export interface ReaderSettings {
  fontSize: number;
  contentWidth: number;
  lineHeight: number;
  fontFamily: FontFamily;
  paragraphSpacing: ParagraphSpacing;
  sceneLensEnabled: boolean;
  reducedEffects: boolean;
  printLayout: PrintLayout;
  printWithTheme: boolean;
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  lastHeadingId?: string | null;
}

export interface NavigationEntry {
  filePath: string;
  headingId: string | null;
}

export interface SessionData {
  filePath: string;
  headingId: string | null;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink";

export interface Highlight {
  id: string;
  prefix: string;
  exact: string;
  suffix: string;
  color: HighlightColor;
  createdAt: number;
  nearestHeadingId: string | null;
  note?: string;
}

export interface Bookmark {
  id: string;
  headingId: string;
  headingText: string;
  createdAt: number;
}

export interface FileAnnotations {
  version?: number;
  highlights: Highlight[];
  bookmarks: Bookmark[];
}

export type ErrorCategory = "not-found" | "too-large" | "not-markdown" | "utf8" | "generic";

export interface AppError {
  message: string;
  category: ErrorCategory;
}

export interface FileRevision {
  mtimeMs: number;
  size: number;
  contentHash: string;
}

export interface OpenFileResult {
  canonicalPath: string;
  name: string;
  content: string;
  revision: FileRevision;
}

export interface FileChangedEvent {
  path: string;
}

export type WorkspaceStatus = "idle" | "indexing" | "ready" | "error";

export interface WorkspaceState {
  rootPath: string | null;
  status: WorkspaceStatus;
  fileCount: number;
  indexedCount: number;
  indexedAt: number | null;
  error: string | null;
  listSkippedCount: number;
  readFailedCount: number;
  limitHit: boolean;
}

export interface WorkspaceFileMeta {
  path: string;
  relPath: string;
  name: string;
  mtimeMs: number;
  size: number;
}

export interface WorkspaceHeading {
  id: string;
  text: string;
}

export interface SceneItem {
  id: string;
  label: string;
  line: number;
  headingId: string | null;
}

export interface CharacterInfo {
  name: string;
  dialogueCount: number;
  firstSceneId: string | null;
}

export interface ParsedSceneHeading {
  intExt: "INT" | "EXT" | "INT/EXT" | null;
  location: string;
  timeOfDay: string | null;
}

export interface ScriptSceneStats {
  sceneId: string;
  heading: string;
  parsed: ParsedSceneHeading;
  wordCount: number;
  pageEstimate: number;
  characterNames: string[];
}

export interface ScriptCharacterStats {
  name: string;
  dialogueCount: number;
  dialogueWordCount: number;
  speakingTimeMinutes: number;
  sceneCount: number;
  firstSceneId: string | null;
  lastSceneId: string | null;
}

export interface ScriptStats {
  totalPages: number;
  estimatedRuntimeMinutes: number;
  speakingCharacterCount: number;
  uniqueLocationCount: number;
  dialoguePercentage: number;
  scenes: ScriptSceneStats[];
  characters: ScriptCharacterStats[];
}

export interface WorkspaceDocIndex {
  path: string;
  relPath: string;
  name: string;
  title: string | null;
  headings: WorkspaceHeading[];
  bodyText: string;
  links: string[];
  scenes: SceneItem[];
}

export interface WorkspaceSearchHit {
  path: string;
  relPath: string;
  kind: "title" | "heading" | "content";
  score: number;
  headingId: string | null;
  heading?: string;
  snippet?: string;
}

export interface BacklinkItem {
  fromPath: string;
  relPath: string;
  context: string;
}

export interface MentionItem {
  path: string;
  relPath: string;
  matchText: string;
  context: string;
}
