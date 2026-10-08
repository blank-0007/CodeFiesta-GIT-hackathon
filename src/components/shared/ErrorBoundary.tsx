import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
  resetKey?: unknown;
}
interface State {
  error: Error | null;
}

/** Per-route error boundary — resets when resetKey (the pathname) changes. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Route error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="card mx-auto mt-16 max-w-lg p-6 text-center">
        <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-crit" aria-hidden />
        <h2 className="text-base font-semibold">This page hit an unexpected error</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your data is safe — nothing was changed. You can retry or go back to the dashboard.
        </p>
        <pre className="num mt-4 max-h-32 overflow-auto rounded-md bg-surface-2 p-2 text-left text-2xs text-muted-foreground">
          {this.state.error.message}
        </pre>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>
            <RefreshCw /> Retry
          </Button>
          <Button variant="ghost" onClick={() => (window.location.href = "/")}>
            Dashboard
          </Button>
        </div>
      </div>
    );
  }
}
