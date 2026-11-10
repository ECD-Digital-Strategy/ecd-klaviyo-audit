import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** Smaller panel for inside the app shell, so the menu stays usable. */
  compact?: boolean;
  /** Changing this clears the error, e.g. the pathname so moving to another page recovers. */
  resetKey?: string;
};

type State = { error: Error | null };

// Without this, any render error (or a page chunk that no longer exists after a
// deploy) left a blank white screen with no way out but a manual refresh.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const panel = (
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-bold text-gray-900">Something went wrong</h1>
        <p className="text-sm leading-relaxed text-gray-500">
          This page hit a problem. Reloading usually fixes it, especially just after an update.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary-dark"
        >
          Reload
        </button>
      </div>
    );
    if (this.props.compact) {
      return <div className="flex flex-1 items-center justify-center p-6">{panel}</div>;
    }
    return <div className="flex min-h-screen items-center justify-center bg-[#f9f9f9] p-6">{panel}</div>;
  }
}
