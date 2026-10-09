import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ToastProvider } from "./components/ToastProvider";
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
  await document.fonts.ready;
  const allLoaded = CRITICAL_FONTS.every((f) => document.fonts.check(`16px "${f}"`));
  if (!allLoaded) {
    await new Promise<void>((r) => setTimeout(r, 150));
  }
}

function dismissLoadingScreen(): void {
  const el = document.getElementById("loading-screen");
  if (!el) return;

  // index.html styles the exit, including the shorter dissolve for reduced motion.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
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
