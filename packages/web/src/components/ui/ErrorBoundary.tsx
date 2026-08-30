import { Component, type ComponentChildren, type ErrorInfo, type VNode } from 'preact';

export interface ErrorBoundaryProps {
  children: ComponentChildren;
  fallback?: VNode;
  onError?: (error: unknown, errorInfo: ErrorInfo) => void;
}

export interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div class="flex flex-col items-center justify-center h-full gap-3 p-4">
          <p class="text-sm text-fg-muted">Failed to load component</p>
          <button
            type="button"
            class="text-sm text-accent hover:text-accent-soft underline"
            onClick={this.handleRetry}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
