import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ToastProvider } from "./components/ToastProvider";
import { getActiveDialog } from "./components/DialogFrame";
import { appReadyPromise, STARTUP_TIMEOUT_MS } from "./lib/app-ready";
import "./app.css";

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

const CRITICAL_FONTS = ["Outfit Variable", "Newsreader Variable", "Geist Mono"];

async function waitForCriticalFonts(): Promise<void> {
  // The welcome tagline is italic but renders only once the app is ready. Load its
  // face now, so the tagline can't change font as the startup screen leaves.
  document.fonts.load('italic 16px "Newsreader Variable"').catch(() => {});
  await document.fonts.ready;
  const allLoaded = CRITICAL_FONTS.every((f) => document.fonts.check(`16px "${f}"`));
  if (!allLoaded) {
    await new Promise<void>((r) => setTimeout(r, 150));
  }
}

const GLIDE_MS = 320;
const WORDMARK_REVEAL_MS = 120;

// Moves the startup mark onto the welcome screen's symbol while the startup screen
// fades, so the two never show at once and the symbol arrives where it stays.
function glideStartupMark(target: SVGElement): void {
  const mark = document.querySelector<SVGSVGElement>("#loading-screen-mark");
  if (!mark) return;
  const from = mark.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!from.width || !to.width) return;

  // Move the mark out of the screen so its fade doesn't take the mark with it.
  mark.removeAttribute("id");
  mark.setAttribute("aria-hidden", "true");
  mark.style.cssText = `position: fixed; z-index: 100000; pointer-events: none; left: ${from.left}px; top: ${from.top}px; width: ${from.width}px; height: ${from.height}px;`;
  document.body.append(mark);
  target.style.visibility = "hidden";

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const glide = mark.animate(
    [{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${to.width / from.width})` }],
    { duration: GLIDE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
  );
  // The mark passes over the wordmark on its way, so the wordmark appears at the
  // end of the glide, once the mark is clear of it.
  const reveal = document.querySelector("[data-startup-mark-passes]")?.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { delay: GLIDE_MS - WORDMARK_REVEAL_MS, duration: WORDMARK_REVEAL_MS, easing: "ease-out", fill: "backwards" },
  );
  const interruptions = ["resize", "click", "keydown"] as const;
  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    clearTimeout(timeout);
    for (const event of interruptions) window.removeEventListener(event, land, true);
    target.style.visibility = "";
    glide.cancel();
    reveal?.cancel();
    mark.remove();
  };
  // Input or a resize can replace or move the destination before the mark lands.
  for (const event of interruptions) window.addEventListener(event, land, true);
  // Safety, as for the screen: animations may not run in a window that isn't shown.
  const timeout = setTimeout(land, GLIDE_MS + 200);
  glide.finished.then(land, land);
}

function dismissLoadingScreen(): void {
  const el = document.getElementById("loading-screen");
  if (!el) return;

  // index.html styles the exit, including the shorter dissolve for reduced motion.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // EmptyState marks its symbol. Opening into a document or dialog keeps the plain fade.
      const target = document.querySelector<SVGElement>("[data-startup-mark-target]");
      if (target && !getActiveDialog()) {
        el.classList.add("to-welcome");
        if (!document.documentElement.classList.contains("reduced-motion")) glideStartupMark(target);
      }
      el.classList.add("fade-out");
      // The mark's own, shorter fade also bubbles here; wait for the screen's.
      el.addEventListener("transitionend", (event) => {
        if (event.target === el) el.remove();
      });
      // Safety: remove after 300ms even if transitionend doesn't fire
      setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
    });
  });
}

async function bootstrap() {
  renderApp();

  // Wait for fonts + app state, with a safety timeout
  try {
    await Promise.race([
      Promise.all([waitForCriticalFonts(), appReadyPromise]),
      new Promise<void>((r) => setTimeout(r, STARTUP_TIMEOUT_MS)),
    ]);
  } catch {
    // proceed even if something fails
  }

  dismissLoadingScreen();
}

void bootstrap();
