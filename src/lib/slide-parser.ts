import { extractFrontmatter } from "./frontmatter";

export interface Slide {
  content: string;
  index: number;
}

/**
 * Parse markdown content into presentation slides.
 *
 * Primary split: `---` horizontal rules (code-fence aware — skip `---` inside ``` blocks).
 * Fallback: if only one slide after HR split, split on `## ` h2 headings instead.
 * Frontmatter: if present and has a title, generate a title slide from it.
 */
export function parseSlides(rawContent: string): Slide[] {
  if (!rawContent.trim()) return [];

  const { frontmatter, body } = extractFrontmatter(rawContent);

  // Build title slide from frontmatter if available
  let titleSlide: string | null = null;
  if (frontmatter?.title) {
    const parts: string[] = [`# ${frontmatter.title}`];
    if (frontmatter.author) parts.push(`\n*${frontmatter.author}*`);
    if (frontmatter.date) parts.push(`\n${frontmatter.date}`);
    titleSlide = parts.join("\n");
  }

  // Split on --- horizontal rules, respecting code fences
  const hrSlides = splitOnHorizontalRules(body);

  let contentSlides: Slide[];

  if (hrSlides.length <= 1) {
    // Fallback: split on ## headings
    const h2Slides = splitOnH2Headings(body);
    contentSlides = h2Slides;
  } else {
    contentSlides = hrSlides;
  }

  // Filter out empty slides
  contentSlides = contentSlides.filter((s) => s.content.trim().length > 0);

  // Prepend title slide if we have one
  if (titleSlide) {
    // Re-index all content slides
    const allSlides: Slide[] = [{ content: titleSlide, index: 0 }];
    for (let i = 0; i < contentSlides.length; i++) {
      allSlides.push({ content: contentSlides[i].content, index: i + 1 });
    }
    return allSlides;
  }

  // Re-index
  return contentSlides.map((s, i) => ({ content: s.content, index: i }));
}

function splitOnHorizontalRules(body: string): Slide[] {
  const lines = body.split("\n");
  const slides: Slide[] = [];
  let current: string[] = [];
  let activeFence: string | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!activeFence) {
        activeFence = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === activeFence) {
        activeFence = null;
      }
    }

    if (!activeFence && /^---\s*$/.test(line)) {
      // Check if this is a setext heading underline (previous line is non-empty text)
      const prevLine = current.length > 0 ? current[current.length - 1] : "";
      if (prevLine.trim().length > 0 && !/^---\s*$/.test(prevLine)) {
        // Setext h2 underline — treat as content, not a slide break
        current.push(line);
      } else {
        slides.push({ content: current.join("\n"), index: slides.length });
        current = [];
      }
    } else {
      current.push(line);
    }
  }

  // Push remaining content
  if (current.length > 0) {
    slides.push({ content: current.join("\n"), index: slides.length });
  }

  return slides;
}

function splitOnH2Headings(body: string): Slide[] {
  const lines = body.split("\n");
  const slides: Slide[] = [];
  let current: string[] = [];
  let activeFence: string | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!activeFence) {
        activeFence = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === activeFence) {
        activeFence = null;
      }
    }

    if (!activeFence && /^## /.test(line)) {
      // Start a new slide at each h2
      if (current.length > 0) {
        slides.push({ content: current.join("\n"), index: slides.length });
      }
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    slides.push({ content: current.join("\n"), index: slides.length });
  }

  return slides;
}
