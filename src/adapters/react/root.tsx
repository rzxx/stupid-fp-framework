import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root, type RootOptions } from "react-dom/client";

export type ProgramReactRootOptions<TBootstrap> = RootOptions & {
  root: HTMLElement;
  bootstrap?: TBootstrap;
  render: (bootstrap: TBootstrap | undefined) => ReactNode;
  errorFallback?: (error: unknown) => ReactNode;
};

export function mountProgramReact<TBootstrap>(options: ProgramReactRootOptions<TBootstrap>): Root {
  const app = (
    <ProgramRootErrorBoundary fallback={options.errorFallback}>
      {options.render(options.bootstrap)}
    </ProgramRootErrorBoundary>
  );
  const rootOptions: RootOptions = {
    identifierPrefix: options.identifierPrefix,
    onCaughtError: options.onCaughtError,
    onRecoverableError: options.onRecoverableError,
    onUncaughtError: options.onUncaughtError,
  };

  if (options.bootstrap !== undefined && options.root.hasChildNodes()) {
    return hydrateRoot(options.root, app, rootOptions);
  }

  const root = createRoot(options.root, rootOptions);
  root.render(app);
  return root;
}

class ProgramRootErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback?: (error: unknown) => ReactNode;
  },
  {
    error: unknown;
  }
> {
  state = {
    error: null,
  };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Root callbacks receive the structured React 19 error details.
  }

  override render() {
    if (this.state.error) {
      return this.props.fallback ? this.props.fallback(this.state.error) : null;
    }

    return this.props.children;
  }
}
