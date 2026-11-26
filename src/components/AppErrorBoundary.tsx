import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NATIVE_QUIT_REQUESTED_EVENT } from "../hooks/useNativeQuit";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[app-error-boundary] Render crash:", error, info);
  }

  private stopCrashListeners: (() => void) | null = null;

  componentDidMount(): void {
    if (this.state.error) this.listenForCrashExit();
  }

  componentDidUpdate(_previousProps: AppErrorBoundaryProps, previousState: AppErrorBoundaryState): void {
    if (this.state.error && !previousState.error) this.listenForCrashExit();
  }

  componentWillUnmount(): void {
    this.stopCrashListeners?.();
  }

  private listenForCrashExit(): void {
    let active = true;
    const detachers: (() => void)[] = [];
    // The crashed child tree no longer owns a save decision or quit listener.
    const quit = () => {
      if (active) void invoke("exit_after_guarded_quit").catch((error) => {
        console.error("[app-error-boundary] Failed to quit:", error);
      });
    };
    for (const registration of [
      listen(NATIVE_QUIT_REQUESTED_EVENT, quit),
      Promise.resolve().then(() => getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        quit();
      })),
    ]) {
      void registration.then((detach) => {
        if (active) detachers.push(detach);
        else detach();
      }).catch((error) => console.error("[app-error-boundary] Failed to attach quit listener:", error));
    }
    this.stopCrashListeners = () => { active = false; for (const detach of detachers) detach(); };
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div
        className="h-screen flex items-center justify-center bg-bg-primary text-text-primary px-6"
        data-testid="app-error-boundary"
      >
        <div className="max-w-[560px] w-full rounded-surface border border-border bg-bg-secondary p-6">
          <h1 className="text-xl font-semibold">Bindars hit an unexpected error</h1>
          <p className="mt-2 text-sm text-text-secondary">
            The view crashed while rendering. Reload to recover.
          </p>
          <pre className="mt-4 max-h-[180px] overflow-auto rounded-surface bg-bg-tertiary p-3 text-xs text-text-muted whitespace-pre-wrap break-words">
            {this.state.error.message}
          </pre>
          <div className="mt-4">
            <button
              type="button"
              onClick={this.handleReload}
              className="px-4 py-2 rounded-control bg-accent-fill text-on-accent text-sm hover:bg-accent-fill-hover transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
