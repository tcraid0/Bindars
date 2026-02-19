import { memo, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { parseFountain, normalizeCharacterName } from "../lib/fountain";
import type { FountainToken, FountainTitlePageEntry } from "../lib/fountain";
import { resolveFontCss, resolveParagraphSpacingCss } from "../lib/reader-settings";
import type { ReaderSettings } from "../types";

/**
 * Parse Fountain inline emphasis markers and return React elements.
 * Supports: ***bold italic***, **bold**, *italic*, _underline_
 */
function renderFountainText(text: string): ReactNode {
  // Match emphasis patterns in priority order (longest markers first)
  const EMPHASIS_RE =
    /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_)/g;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = EMPHASIS_RE.exec(text)) !== null) {
    // Push preceding plain text
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[2] != null) {
      // ***bold italic***
      parts.push(
        <strong key={key}>
          <em>{match[2]}</em>
        </strong>,
      );
    } else if (match[3] != null) {
      // **bold**
      parts.push(<strong key={key}>{match[3]}</strong>);
    } else if (match[4] != null) {
      // *italic*
      parts.push(<em key={key}>{match[4]}</em>);
    } else if (match[5] != null) {
      // _underline_
      parts.push(
        <span key={key} style={{ textDecoration: "underline" }}>
          {match[5]}
        </span>,
      );
    }
    key++;
    lastIndex = match.index + match[0].length;
  }

  // Trailing plain text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  // If no emphasis found, return the original string (avoids unnecessary wrapper)
  return parts.length === 1 && typeof parts[0] === "string" ? text : parts;
}

interface FountainRendererProps {
  content: string;
  filePath: string;
  settings: ReaderSettings;
  contentRef: React.RefObject<HTMLElement | null>;
  focusedCharacter?: string | null;
}

/* ------------------------------------------------------------------ */
/*  FountainContent — memoized expensive parsing + rendering           */
/* ------------------------------------------------------------------ */

const FountainContent = memo(function FountainContent({
  content,
}: {
  content: string;
}) {
  const parsed = useMemo(() => parseFountain(content), [content]);

  // Group tokens, collecting dual-dialogue blocks into paired arrays.
  // Track current character name for data-character attributes.
  type SingleGroup = { kind: "single"; token: FountainToken; index: number; sceneId?: string; characterName?: string };
  type DualGroup = { kind: "dual"; left: Array<FountainToken & { _charName?: string }>; right: Array<FountainToken & { _charName?: string }>; index: number };

  const groups = useMemo(() => {
    const result: Array<SingleGroup | DualGroup> = [];

    let sceneIdx = 0;
    let currentChar = "";
    let i = 0;
    while (i < parsed.tokens.length) {
      const token = parsed.tokens[i];
      if (token.type === "dual_dialogue_begin") {
        // Collect tokens until dual_dialogue_end
        i++;
        const left: Array<FountainToken & { _charName?: string }> = [];
        const right: Array<FountainToken & { _charName?: string }> = [];
        let seenDual = false;
        let dualChar = "";
        while (i < parsed.tokens.length && parsed.tokens[i].type !== "dual_dialogue_end") {
          const t = parsed.tokens[i];
          if (t.type === "dialogue_begin") {
            if (t.dual === "right") seenDual = true;
            i++;
            continue;
          }
          if (t.type === "dialogue_end") {
            i++;
            continue;
          }
          if (t.type === "character" && t.text) {
            if (seenDual || t.dual === "right") {
              dualChar = normalizeCharacterName(t.text);
            } else {
              currentChar = normalizeCharacterName(t.text);
            }
          }
          if (t.dual === "right" || seenDual) {
            seenDual = true;
            right.push({ ...t, _charName: (t.type === "character" || t.type === "dialogue" || t.type === "parenthetical") ? (dualChar || undefined) : undefined });
          } else {
            left.push({ ...t, _charName: (t.type === "character" || t.type === "dialogue" || t.type === "parenthetical") ? (currentChar || undefined) : undefined });
          }
          i++;
        }
        result.push({ kind: "dual", left, right, index: i });
        i++; // skip dual_dialogue_end
      } else if (token.type === "scene_heading") {
        const scene = parsed.scenes[sceneIdx];
        sceneIdx++;
        result.push({ kind: "single", token, index: i, sceneId: scene?.id });
        i++;
      } else {
        if (token.type === "character" && token.text) {
          currentChar = normalizeCharacterName(token.text);
        }
        const charName = (token.type === "character" || token.type === "dialogue" || token.type === "parenthetical")
          ? (currentChar || undefined)
          : undefined;
        result.push({ kind: "single", token, index: i, characterName: charName });
        i++;
      }
    }

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
                {group.left.map((t, j) => (
                  <FountainElement key={j} token={t} characterName={t._charName} />
                ))}
              </div>
              <div className="fountain-dual-column">
                {group.right.map((t, j) => (
                  <FountainElement key={j} token={t} characterName={t._charName} />
                ))}
              </div>
            </div>
          );
        }
        return (
          <FountainElement
            key={group.index}
            token={group.token}
            sceneId={group.sceneId}
            characterName={group.characterName}
          />
        );
      })}
    </>
  );
});

/* ------------------------------------------------------------------ */
/*  FountainRenderer — thin style shell                                */
/* ------------------------------------------------------------------ */

function FountainRendererComponent({
  content,
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
      className="fountain-body file-content-enter"
      style={{
        maxWidth: `${settings.contentWidth}ch`,
        fontSize: `${settings.fontSize}px`,
        lineHeight: settings.lineHeight,
        fontFamily: resolveFontCss(settings.fontFamily),
        "--paragraph-spacing": resolveParagraphSpacingCss(settings.paragraphSpacing),
        margin: "0 auto",
        padding: "48px 24px 80px",
      } as React.CSSProperties}
    >
      <FountainContent content={content} />
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
      {title && <h1 className="fountain-title">{title}</h1>}
      {credit && <p className="fountain-credit">{credit}</p>}
      {author && <p className="fountain-author">{author}</p>}
      {draftDate && <p className="fountain-draft-date">{draftDate}</p>}
      {entries
        .filter(
          (e) =>
            !["title", "credit", "author", "draft date"].includes(
              e.key.toLowerCase(),
            ),
        )
        .map((e, i) => (
          <p key={i} className="fountain-title-entry">
            {e.value}
          </p>
        ))}
    </header>
  );
}

function FountainElement({
  token,
  sceneId,
  characterName,
}: {
  token: FountainToken;
  sceneId?: string;
  characterName?: string;
}) {
  switch (token.type) {
    case "scene_heading":
      return (
        <h3 id={sceneId} className="fountain-scene-heading">
          {token.text ? renderFountainText(token.text) : null}
          {token.scene_number && (
            <span className="fountain-scene-number">
              {token.scene_number}
            </span>
          )}
        </h3>
      );

    case "action":
      return <p className="fountain-action">{token.text ? renderFountainText(token.text) : null}</p>;

    case "character":
      return <p className="fountain-character" data-character={characterName}>{token.text ? renderFountainText(token.text) : null}</p>;

    case "dialogue":
      return <p className="fountain-dialogue" data-character={characterName}>{token.text ? renderFountainText(token.text) : null}</p>;

    case "parenthetical":
      return <p className="fountain-parenthetical" data-character={characterName}>{token.text ? renderFountainText(token.text) : null}</p>;

    case "transition":
      return <p className="fountain-transition">{token.text ? renderFountainText(token.text) : null}</p>;

    case "centered":
      return <p className="fountain-centered">{token.text ? renderFountainText(token.text) : null}</p>;

    case "section":
      return <p className="fountain-section">{token.text ? renderFountainText(token.text) : null}</p>;

    case "synopsis":
      return <p className="fountain-synopsis">{token.text ? renderFountainText(token.text) : null}</p>;

    case "note":
      return <p className="fountain-note">{token.text ? renderFountainText(token.text) : null}</p>;

    case "lyrics":
      return <p className="fountain-lyrics">{token.text ? renderFountainText(token.text) : null}</p>;

    case "page_break":
      return <hr className="fountain-page-break" />;

    case "dialogue_begin":
    case "dialogue_end":
    case "dual_dialogue_begin":
    case "dual_dialogue_end":
    case "spaces":
      return null;

    default:
      return null;
  }
}
