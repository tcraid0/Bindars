import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ToastProvider } from "./components/ToastProvider";
import { runMigrations } from "./lib/migrations";
import { appReadyPromise } from "./lib/app-ready";
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

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) {
    el.remove();
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add("fade-out");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      // Safety: remove after 300ms even if transitionend doesn't fire
      setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
    });
  });
}

async function bootstrap() {
  // Fire-and-forget migrations — hooks handle missing/stale store values gracefully
  runMigrations().catch((err) => {
    console.warn("[migrations] Failed to run startup migrations:", err);
  });

  renderApp();

  // Wait for fonts + app state, with a safety timeout
  try {
    await Promise.race([
      Promise.all([waitForCriticalFonts(), appReadyPromise]),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
  } catch {
    // proceed even if something fails
  }

  dismissLoadingScreen();
}

void bootstrap();
