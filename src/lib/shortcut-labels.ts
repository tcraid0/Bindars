export type ShortcutPlatform = "macos" | "windows-linux";

export interface ShortcutNavigator {
  readonly platform?: string;
  readonly userAgent?: string;
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

type ShortcutModifier = "primary" | "alt" | "shift";

interface ShortcutDefinition {
  readonly modifiers: readonly ShortcutModifier[];
  readonly key: string;
}

const SHORTCUT_DEFINITIONS = {
  newFile: { modifiers: ["primary"], key: "N" },
  openFile: { modifiers: ["primary"], key: "O" },
  workspaceSwitcher: { modifiers: ["primary"], key: "K" },
  goBack: { modifiers: ["alt"], key: "←" },
  goForward: { modifiers: ["alt"], key: "→" },
  previousScene: { modifiers: ["alt"], key: "↑" },
  nextScene: { modifiers: ["alt"], key: "↓" },
  toggleSidebar: { modifiers: ["primary"], key: "B" },
  toggleTableOfContents: { modifiers: ["primary"], key: "J" },
  toggleBothPanels: { modifiers: ["primary"], key: "\\" },
  focusMode: { modifiers: ["primary", "shift"], key: "F" },
  cycleTheme: { modifiers: ["primary", "shift"], key: "T" },
  searchDocument: { modifiers: ["primary"], key: "F" },
  bookmarkHeading: { modifiers: ["primary"], key: "D" },
  toggleAnnotations: { modifiers: ["primary"], key: "M" },
  print: { modifiers: ["primary"], key: "P" },
  increaseFontSize: { modifiers: ["primary"], key: "+" },
  decreaseFontSize: { modifiers: ["primary"], key: "−" },
  resetSettings: { modifiers: ["primary"], key: "0" },
  toggleEditMode: { modifiers: ["primary"], key: "E" },
  saveFile: { modifiers: ["primary"], key: "S" },
  toggleMarkdownFormatting: { modifiers: ["primary", "alt"], key: "M" },
  escape: { modifiers: [], key: "Esc" },
  showShortcuts: { modifiers: [], key: "?" },
  presentation: { modifiers: [], key: "F5" },
  enter: { modifiers: [], key: "Enter" },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUT_DEFINITIONS;

interface ShortcutSectionEntry {
  readonly id: ShortcutId;
  readonly label: string;
}

interface ShortcutSection {
  readonly title: string;
  readonly shortcuts: readonly ShortcutSectionEntry[];
}

export const SHORTCUT_SECTIONS = [
  {
    title: "Navigation",
    shortcuts: [
      { id: "newFile", label: "New file" },
      { id: "openFile", label: "Open file" },
      { id: "workspaceSwitcher", label: "Workspace quick switcher" },
      { id: "goBack", label: "Go back" },
      { id: "goForward", label: "Go forward" },
      { id: "previousScene", label: "Previous scene" },
      { id: "nextScene", label: "Next scene" },
    ],
  },
  {
    title: "View",
    shortcuts: [
      { id: "toggleSidebar", label: "Toggle sidebar" },
      { id: "toggleTableOfContents", label: "Toggle table of contents" },
      { id: "toggleBothPanels", label: "Toggle both panels" },
      { id: "focusMode", label: "Focus mode" },
      { id: "cycleTheme", label: "Cycle theme" },
    ],
  },
  {
    title: "Reading",
    shortcuts: [
      { id: "searchDocument", label: "Search in document" },
      { id: "bookmarkHeading", label: "Bookmark current heading" },
      { id: "toggleAnnotations", label: "Toggle annotations panel" },
      { id: "print", label: "Print / export PDF" },
      { id: "increaseFontSize", label: "Increase font size" },
      { id: "decreaseFontSize", label: "Decrease font size" },
      { id: "resetSettings", label: "Reset settings" },
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      { id: "toggleEditMode", label: "Toggle edit mode" },
      { id: "saveFile", label: "Save file" },
      { id: "toggleMarkdownFormatting", label: "Toggle markup formatting" },
      { id: "escape", label: "Exit edit mode" },
    ],
  },
  {
    title: "General",
    shortcuts: [
      { id: "showShortcuts", label: "Show keyboard shortcuts" },
      { id: "escape", label: "Close overlay / exit focus" },
    ],
  },
] as const satisfies readonly ShortcutSection[];

const MODIFIER_LABELS: Record<ShortcutPlatform, Record<ShortcutModifier, string>> = {
  macos: {
    primary: "⌘",
    alt: "⌥",
    shift: "⇧",
  },
  "windows-linux": {
    primary: "Ctrl",
    alt: "Alt",
    shift: "Shift",
  },
};

// Apple's convention lists modifiers as Control, Option, Shift, Command, so
// Command renders last on macOS; Windows and Linux conventionally lead with Ctrl.
const MODIFIER_DISPLAY_ORDER: Record<ShortcutPlatform, readonly ShortcutModifier[]> = {
  macos: ["alt", "shift", "primary"],
  "windows-linux": ["primary", "alt", "shift"],
};

function currentNavigator(): ShortcutNavigator | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

function isMacPlatform(platform: string | undefined): boolean {
  return platform?.toLowerCase().startsWith("mac") ?? false;
}

export function detectShortcutPlatform(
  navigatorLike: ShortcutNavigator | null | undefined = currentNavigator(),
): ShortcutPlatform {
  if (!navigatorLike) return "windows-linux";

  if (
    isMacPlatform(navigatorLike.userAgentData?.platform)
    || isMacPlatform(navigatorLike.platform)
  ) {
    return "macos";
  }

  if (navigatorLike.userAgent?.includes("Macintosh")) return "macos";
  return "windows-linux";
}

function formatShortcut(
  definition: ShortcutDefinition,
  platform: ShortcutPlatform,
): string {
  const separator = platform === "macos" ? "" : "+";
  const modifiers = MODIFIER_DISPLAY_ORDER[platform]
    .filter((modifier) => definition.modifiers.includes(modifier))
    .map((modifier) => MODIFIER_LABELS[platform][modifier]);
  return [...modifiers, definition.key].join(separator);
}

export function formatShortcutLabel(
  id: ShortcutId,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return formatShortcut(SHORTCUT_DEFINITIONS[id], platform);
}

const SHORTCUT_TOKEN_PATTERN = /\{\{shortcut:([A-Za-z][A-Za-z0-9]*)\}\}/g;

export function renderShortcutTemplate(
  template: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  const rendered = template.replace(SHORTCUT_TOKEN_PATTERN, (_token, candidateId: string) => {
    if (!Object.prototype.hasOwnProperty.call(SHORTCUT_DEFINITIONS, candidateId)) {
      throw new Error(`Unknown shortcut token: ${candidateId}`);
    }
    return formatShortcutLabel(candidateId as ShortcutId, platform);
  });

  if (rendered.includes("{{shortcut:")) {
    throw new Error("Unresolved shortcut token in template");
  }

  return rendered;
}
