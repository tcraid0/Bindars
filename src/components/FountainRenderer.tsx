import { Fragment, memo, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { normalizeCharacterName, splitFountainInline } from "../lib/fountain";
import type { FountainToken, FountainTitlePageEntry, ParsedFountain } from "../lib/fountain";
import { resolveParagraphSpacingCss, resolveReaderSurfaceStyle } from "../lib/reader-settings";
import type { ReaderSettings } from "../types";

/** Render Fountain inline emphasis (***, **, *, _) and backslash escapes. */
function renderFountainText(text: string): ReactNode {
  const segments = splitFountainInline(text);
  if (segments.every((segment) => !segment.bold && !segment.italic && !segment.underline)) {
    return segments.map((segment) => segment.text).join("");
  }
  return segments.map((segment, index) => {
    let node: ReactNode = segment.text;
    if (segment.italic) node = <em>{node}</em>;
    if (segment.bold) node = <strong>{node}</strong>;
    if (segment.underline) node = <span style={{ textDecoration: "underline" }}>{node}</span>;
    return <Fragment key={index}>{node}</Fragment>;
  });
}

interface FountainRendererProps {
  parsed: ParsedFountain;
  settings: ReaderSettings;
  contentRef: React.RefObject<HTMLElement | null>;
  focusedCharacter?: string | null;
}

/* ------------------------------------------------------------------ */
/*  FountainContent — memoized expensive parsing + rendering           */
/* ------------------------------------------------------------------ */

const FountainContent = memo(function FountainContent({
  parsed,
}: {
  parsed: ParsedFountain;
}) {
  // fountain-js wraps a dual pair as dual_dialogue_begin, the left block, a
  // dialogue_begin tagged dual="right", the right block, dual_dialogue_end.
  // Every other token renders on its own, tagged with the current speaker.
  type Element = {
    token: FountainToken;
    index: number;
    sceneId?: string;
    sourceLine?: number;
    sourceColumn?: number;
    characterName?: string;
  };
  type Group =
    | ({ kind: "single" } & Element)
    | { kind: "dual"; left: Element[]; right: Element[]; index: number };

  const groups = useMemo(() => {
    const result: Group[] = [];
    let sceneIdx = 0;
    let currentCharacter = "";
    let dual: { kind: "dual"; left: Element[]; right: Element[]; index: number } | null = null;
    let dualSide: "left" | "right" = "left";

    parsed.tokens.forEach((token, index) => {
      if (token.type === "dual_dialogue_begin") {
        dual = { kind: "dual", left: [], right: [], index };
        dualSide = "left";
        return;
      }
      if (token.type === "dual_dialogue_end") {
        if (dual) result.push(dual);
        dual = null;
        return;
      }
      if (token.type === "dialogue_begin" && token.dual === "right") dualSide = "right";
      if (token.type === "character" && token.text) currentCharacter = normalizeCharacterName(token.text);

      const element: Element = { token, index };
      if (token.type === "scene_heading") {
        const scene = parsed.scenes[sceneIdx];
        sceneIdx += 1;
        element.sceneId = scene?.id;
        element.sourceLine = scene?.source?.line;
        element.sourceColumn = scene?.source?.column;
      } else if (SPEECH_TOKEN_TYPES.has(token.type) && currentCharacter) {
        element.characterName = currentCharacter;
      }

      if (dual) dual[dualSide].push(element);
      else result.push({ kind: "single", ...element });
    });
    // An unterminated pair still shows its content, in the left column.
    if (dual) result.push(dual);

    return result;
  }, [parsed]);

  return (
    <>
      {parsed.titlePage.length > 0 && (
        <FountainTitlePage entries={parsed.titlePage} />
      )}
      {groups.map((group) => {
        if (group.kind === "dual") {
          return (
            <div key={group.index} className="fountain-dual-dialogue">
              <div className="fountain-dual-column">
                {group.left.map((element) => <FountainElement key={element.index} {...element} />)}
              </div>
              <div className="fountain-dual-column">
                {group.right.map((element) => <FountainElement key={element.index} {...element} />)}
              </div>
            </div>
          );
        }
        return <FountainElement key={group.index} {...group} />;
      })}
    </>
  );
});

const SPEECH_TOKEN_TYPES = new Set(["character", "dialogue", "parenthetical"]);

/* ------------------------------------------------------------------ */
/*  FountainRenderer — thin style shell                                */
/* ------------------------------------------------------------------ */

function FountainRendererComponent({
  parsed,
  settings,
  contentRef,
  focusedCharacter,
}: FountainRendererProps) {
  // Imperative DOM update: toggle data-focus-character and data-character-match
  // attributes without busting FountainContent's memo.
  useEffect(() => {
    const article = contentRef.current;
    if (!article) return;

    if (focusedCharacter) {
      article.setAttribute("data-focus-character", focusedCharacter);
      const els = article.querySelectorAll("[data-character]");
      for (const el of els) {
        if (el.getAttribute("data-character") === focusedCharacter) {
          el.setAttribute("data-character-match", "");
        } else {
          el.removeAttribute("data-character-match");
        }
      }
    } else {
      article.removeAttribute("data-focus-character");
      const matched = article.querySelectorAll("[data-character-match]");
      for (const el of matched) {
        el.removeAttribute("data-character-match");
      }
    }
  }, [focusedCharacter, contentRef]);

  return (
    <article
      ref={contentRef}
      className="fountain-body"
      style={{
        ...resolveReaderSurfaceStyle(settings),
        "--paragraph-spacing": resolveParagraphSpacingCss(settings.paragraphSpacing),
      } as React.CSSProperties}
    >
      <FountainContent parsed={parsed} />
    </article>
  );
}

export const FountainRenderer = memo(FountainRendererComponent);

function FountainTitlePage({ entries }: { entries: FountainTitlePageEntry[] }) {
  const title = entries.find(
    (e) => e.key.toLowerCase() === "title",
  )?.value;
  const credit = entries.find(
    (e) => e.key.toLowerCase() === "credit",
  )?.value;
  const author = entries.find(
    (e) => e.key.toLowerCase() === "author",
  )?.value;
  const draftDate = entries.find(
    (e) => e.key.toLowerCase() === "draft date",
  )?.value;

  return (
    <header className="fountain-title-page">
      {title && <h1 className="fountain-title">{renderFountainText(title)}</h1>}
      {credit && <p className="fountain-credit">{renderFountainText(credit)}</p>}
      {author && <p className="fountain-author">{renderFountainText(author)}</p>}
      {draftDate && <p className="fountain-draft-date">{renderFountainText(draftDate)}</p>}
      {entries
        .filter(
          (e) =>
            !["title", "credit", "author", "draft date"].includes(
              e.key.toLowerCase(),
            ),
        )
        .map((e, i) => (
          <p key={i} className="fountain-title-entry">
            {renderFountainText(e.value)}
          </p>
        ))}
    </header>
  );
}

function FountainElement({
  token,
  sceneId,
  sourceLine,
  sourceColumn,
  characterName,
}: {
  token: FountainToken;
  sceneId?: string;
  sourceLine?: number;
  sourceColumn?: number;
  characterName?: string;
}) {
  const text = token.text ? renderFountainText(token.text) : null;
  switch (token.type) {
    case "scene_heading":
      return (
        <h3
          id={sceneId}
          className="fountain-scene-heading"
          data-bindars-source-line={sourceLine}
          data-bindars-source-column={sourceColumn}
        >
          {text}
          {token.scene_number && (
            <span className="fountain-scene-number">
              {token.scene_number}
            </span>
          )}
        </h3>
      );

    case "action":
      return <p className="fountain-action">{text}</p>;

    case "character":
      return <p className="fountain-character" data-character={characterName}>{text}</p>;

    case "dialogue":
      return <p className="fountain-dialogue" data-character={characterName}>{text}</p>;

    case "parenthetical":
      return <p className="fountain-parenthetical" data-character={characterName}>{text}</p>;

    case "transition":
      return <p className="fountain-transition">{text}</p>;

    case "centered":
      return <p className="fountain-centered">{text}</p>;

    case "section":
      return <p className="fountain-section">{text}</p>;

    case "synopsis":
      return <p className="fountain-synopsis">{text}</p>;

    case "note":
      return <p className="fountain-note">{text}</p>;

    case "lyrics":
      return <p className="fountain-lyrics">{text}</p>;

    case "page_break":
      return <hr className="fountain-page-break" />;

    default:
      // dialogue_begin, dialogue_end, dual_dialogue_*, spaces
      return null;
  }
}
