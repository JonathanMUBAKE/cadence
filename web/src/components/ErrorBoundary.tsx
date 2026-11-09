import { Component, type ErrorInfo, type ReactNode } from "react";

/** Dernier filet : une erreur d'affichage ne doit jamais laisser une page blanche. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[cadence] erreur d'affichage", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg"
      >
        <p className="font-serif text-[26px] leading-tight">Un problème d'affichage est survenu</p>
        <p className="max-w-md text-[14px] text-muted">
          Vos données ne sont pas perdues. Rechargez la page pour reprendre.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-1 h-9 rounded-lg bg-primary px-4 text-[13.5px] font-medium text-on-primary hover:opacity-90"
        >
          Recharger
        </button>
      </div>
    );
  }
}
