import React from "react";

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

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="h-screen flex items-center justify-center bg-bg-primary text-text-primary px-6">
        <div className="max-w-[560px] w-full rounded-xl border border-border bg-bg-secondary p-6">
          <h1 className="text-xl font-semibold">Bindars hit an unexpected error</h1>
          <p className="mt-2 text-sm text-text-secondary">
            The view crashed while rendering. Reload to recover.
          </p>
          <pre className="mt-4 max-h-[180px] overflow-auto rounded-md bg-bg-tertiary p-3 text-xs text-text-muted whitespace-pre-wrap break-words">
            {this.state.error.message}
          </pre>
          <div className="mt-4">
            <button
              type="button"
              onClick={this.handleReload}
              className="px-4 py-2 rounded-md bg-accent text-white text-sm hover:bg-accent-hover transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
