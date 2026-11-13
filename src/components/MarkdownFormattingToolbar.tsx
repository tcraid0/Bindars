import { useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CodeMirrorEditorHandle, EditorLinkForm } from "./CodeMirrorEditor";
import { FORMATTING_SHORTCUTS, type FormattingToolbarState, type ToolbarCommand } from "./markdown-formatting-commands";
import { formatShortcutLabel, isPrimaryModifier, type ShortcutId } from "../lib/shortcut-labels";
import { isImeCompositionKey } from "../lib/keyboard";
import { MarkdownFormattingToggle } from "./MarkdownFormattingToggle";
import { useDismissiblePopover } from "../hooks/useDismissiblePopover";

interface Props {
  editorRef: RefObject<CodeMirrorEditorHandle | null>;
  toolbarRef: RefObject<HTMLDivElement | null>;
  state: FormattingToolbarState | null;
  linkForm: EditorLinkForm | null;
  styled: boolean;
  adoption: number;
  onToggleStyled: () => void;
}
const styles = [["paragraph", "Paragraph"], ["h1", "Heading"], ["h2", "Subheading"], ["h3", "Small heading"]] as const;
const more = [["italic", "Italic"], ["link", "Link"], ["quote", "Quote"], ["divider", "Divider"], ["indent", "Indent more"], ["outdent", "Indent less"], ["toggleTask", "Mark done"]] as const;
const controls = [
  { kind: "menu", menu: "style" },
  { kind: "command", command: "bold", label: "Bold" },
  { kind: "command", command: "bullets", label: "Bullets" },
  { kind: "command", command: "numbered", label: "Numbered" },
  { kind: "command", command: "checklist", label: "Checklist" },
  { kind: "menu", menu: "more" },
  { kind: "toggle" },
] as const;
const shortcuts: Partial<Record<ToolbarCommand, ShortcutId>> = {
  ...Object.fromEntries(FORMATTING_SHORTCUTS.map(({ command, shortcut }) => [command, shortcut])),
  indent: "indentList", outdent: "outdentList",
};

export function MarkdownFormattingToolbar({ editorRef, toolbarRef, state, linkForm, styled, adoption, onToggleStyled }: Props) {
  const id = useId();
  const [menu, setMenu] = useState<"style" | "more" | null>(null);
  const [tabStop, setTabStop] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useDismissiblePopover({ open: menu !== null, triggerRef, panelRef, onClose: () => setMenu(null) });
  useLayoutEffect(() => {
    // A native file replacement retires an open menu even when its derived
    // formatting flags happen to match the previous document.
    dismiss(true);
  }, [adoption, dismiss]);
  useLayoutEffect(() => {
    if (menu) panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);
  const feedback = (command: ToolbarCommand) => state?.commands[command];
  const describe = (command: ToolbarCommand) => {
    const item = feedback(command);
    return item?.reason ?? "";
  };
  const run = (command: ToolbarCommand) => {
    dismiss(false);
    if (command === "link") editorRef.current?.beginLink();
    else editorRef.current?.executeFormatting(command);
  };
  const toggleMenu = (name: "style" | "more", trigger: HTMLButtonElement) => {
    if (menu === name) { dismiss(true); return; }
    triggerRef.current = trigger;
    setMenu(name);
  };
  const heading = state?.headingLevel;
  const styleLabel = heading == null ? "Text style" : heading === 0 ? "Paragraph" : heading <= 3 ? styles[heading][1] : `Heading ${heading}`;
  const styleName = heading == null ? "Text style" : `Text style: ${styleLabel}`;
  return (
    <div className="markdown-formatting-bar print-hide" data-markdown-controls onKeyDown={event => {
      if (event.defaultPrevented || isImeCompositionKey(event.nativeEvent) || !isPrimaryModifier(event.nativeEvent)
        || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      if (!target.closest('button') || !target.closest('[role="toolbar"], [role="menu"]')) return;
      const command = FORMATTING_SHORTCUTS.find(({ key }) => key === event.key.toLowerCase())?.command;
      if (command) { event.preventDefault(); event.stopPropagation(); run(command); }
    }}>
      <div ref={toolbarRef} role="toolbar" aria-label="Markdown formatting" aria-describedby={`${id}-help`}
        className="markdown-formatting-toolbar" onKeyDown={event => {
          if (isImeCompositionKey(event.nativeEvent)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          let next: number;
          if (event.key === "ArrowRight") next = (current + 1) % buttons.length;
          else if (event.key === "ArrowLeft") next = (current + buttons.length - 1) % buttons.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = buttons.length - 1;
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editorRef.current?.focus(); return; }
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const control = controls[current];
            if (control?.kind === "menu") {
              event.preventDefault(); toggleMenu(control.menu, buttons[current]);
            }
            return;
          } else return;
          event.preventDefault(); buttons[next]?.focus();
        }}>
        {controls.map((control, index) => {
          const navigation = { "data-toolbar-item": true, tabIndex: tabStop === index ? 0 : -1, onFocus: () => setTabStop(index) };
          if (control.kind === "toggle") return <MarkdownFormattingToggle key="styled" {...navigation} data-styled-toggle
            onMouseDown={event => event.preventDefault()} enabled={styled}
            className="markdown-styled-toggle" onToggle={onToggleStyled} />;
          if (control.kind === "menu") return <button key={control.menu} type="button" {...navigation}
            className={control.menu === "style" ? "markdown-style-button" : undefined}
            aria-label={control.menu === "style" ? styleName : undefined}
            aria-haspopup="menu" aria-expanded={menu === control.menu} aria-controls={menu === control.menu ? `${id}-menu` : undefined}
            onClick={event => toggleMenu(control.menu, event.currentTarget)}>
            {control.menu === "style" ? styleLabel : "More"} <span aria-hidden="true">⌄</span></button>;
          const { command, label } = control;
          return <button key={command} type="button" {...navigation} onMouseDown={event => event.preventDefault()}
            aria-label={label} aria-pressed={feedback(command)?.active ?? undefined}
            aria-disabled={feedback(command)?.available === false} aria-describedby={`${id}-${command}-hint`}
            title={[label, shortcuts[command] && formatShortcutLabel(shortcuts[command]!), describe(command)].filter(Boolean).join(" · ")}
            onClick={() => run(command)}>{label}</button>;
        })}
      </div>
      <span id={`${id}-help`} className="sr-only">{formatShortcutLabel("focusFormattingToolbar")} moves from the editor to formatting. Use arrow keys between controls, Tab to continue, or Escape to return to writing.</span>
      {Object.keys(state?.commands ?? {}).map(command => <span className="sr-only" key={command} id={`${id}-${command}-hint`}>{describe(command as ToolbarCommand)}</span>)}
      {menu && <div ref={panelRef} className={`markdown-formatting-menu markdown-formatting-menu-${menu}`} role="menu" id={`${id}-menu`}
        aria-label={menu === "style" ? "Text style" : "More formatting"} onKeyDown={event => {
          if (isImeCompositionKey(event.nativeEvent)) return;
          if (event.key === "Tab") { setMenu(null); return; }
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowDown" ? (current + 1) % buttons.length
            : event.key === "ArrowUp" ? (current + buttons.length - 1) % buttons.length
            : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
          if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
        }}>
        {(menu === "style" ? styles : more).map(([command, label]) => {
          const active = feedback(command)?.active;
          const toggle = command === "italic" || command === "quote";
          return <button type="button" key={command} role={menu === "style" ? "menuitemradio" : toggle && active != null ? "menuitemcheckbox" : "menuitem"}
          aria-checked={menu === "style" ? active === true : toggle ? active ?? undefined : undefined}
          aria-disabled={feedback(command)?.available === false} tabIndex={-1}
          onClick={() => run(command)}>
          <span>{command === "toggleTask" && active === true ? "Mark not done" : label}</span>{shortcuts[command] && <kbd>{formatShortcutLabel(shortcuts[command]!)}</kbd>}
          {menu === "more" && toggle && active === true && <span aria-hidden="true" className="markdown-menu-check">✓</span>}
          {describe(command) && <small>{describe(command)}</small>}
        </button>; })}
      </div>}
      {linkForm && <LinkForm key={linkForm.id} form={linkForm} editorRef={editorRef} />}
    </div>
  );
}

function LinkForm({ form, editorRef }: { form: EditorLinkForm; editorRef: RefObject<CodeMirrorEditorHandle | null> }) {
  const id = useId();
  const [label, setLabel] = useState(form.label);
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const composingRef = useRef(false);
  useLayoutEffect(() => {
    const element = formRef.current;
    element?.querySelector<HTMLInputElement>(form.label ? '[name="destination"]' : '[name="label"]')?.focus();
    const outside = (event: FocusEvent | PointerEvent) => {
      if (!(event.target instanceof Node) || element?.contains(event.target)) return;
      // The display-only toggle must preserve the draft for both pointer and
      // shortcut use. Other deliberate navigation (including Find) dismisses it.
      if ((event.target as Element).closest?.('[data-styled-toggle]')) return;
      editorRef.current?.cancelLink(form.id, false);
    };
    document.addEventListener("focusin", outside);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("focusin", outside);
      document.removeEventListener("pointerdown", outside);
      // Strict Mode replays subscriptions while the same form DOM is mounted.
      // Only a real removal retires its intent after the commit; queued UI work
      // cannot submit it after this microtask, and replacement IDs stay separate.
      queueMicrotask(() => {
        if (element && !element.isConnected) editorRef.current?.cancelLink(form.id, false);
      });
    };
  }, [editorRef, form.id, form.label]);
  return <form ref={formRef} onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={() => { composingRef.current = false; }} className="markdown-link-form" aria-label="Insert link" onSubmit={event => {
    event.preventDefault();
    const result = editorRef.current?.applyLink(form.id, { label, destination }, composingRef.current);
    setError(result?.reason ?? null);
  }} onKeyDown={event => {
    if (isImeCompositionKey(event.nativeEvent)) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editorRef.current?.cancelLink(form.id); }
  }}>
    <label htmlFor={`${id}-label`}>Link text<input id={`${id}-label`} name="label" value={label} onChange={event => { setLabel(event.target.value); setError(null); }} required /></label>
    <label htmlFor={`${id}-destination`}>Link to<input id={`${id}-destination`} name="destination" value={destination} onChange={event => { setDestination(event.target.value); setError(null); }} required
      aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} /></label>
    <p id={`${id}-hint`}>Web address, email (mailto:), #section, or relative document path.</p>
    {error && <p role="alert" id={`${id}-error`} className="text-danger">{error}</p>}
    {/* macOS may focus the enclosing Document instead of a clicked button.
        Keep the field focused until the action runs, so outside-focus dismissal
        cannot retire the form between mousedown and click. Tab remains native. */}
    <div className="markdown-link-actions" onMouseDown={event => event.preventDefault()}><button type="submit">Add link</button><button type="button" onClick={() => editorRef.current?.cancelLink(form.id)}>Cancel</button></div>
  </form>;
}
