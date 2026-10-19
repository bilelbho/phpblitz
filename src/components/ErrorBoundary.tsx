// A part of the window that failed to draw shows that, with Reload panel and Copy details, instead
// of taking the whole window down with it. The error also goes to Help ▸ Diagnostic Tools ▸ Error Log.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorReport, logError, type LoggedError } from '../errorLog';

interface Props {
  /** What failed, for the message and the log: "Commit", "Editor"… */
  name: string;
  children: ReactNode;
  /** "panel": fills its place; "dialog": a card over the window with Close; "window": the whole app. */
  variant?: 'panel' | 'dialog' | 'window';
  /** Dialogs: closes the dialog. */
  onClose?: () => void;
}

interface State {
  error: Error | null;
  stack?: string;
  copied: 'yes' | 'failed' | null;
  /** Bumped by Reload panel: the children mount again from scratch. */
  generation: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, copied: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = info.componentStack ?? undefined;
    this.setState({ stack });
    logError(`Panel: ${this.props.name}`, error, stack);
  }

  private reload = () => this.setState((s) => ({ error: null, stack: undefined, copied: null, generation: s.generation + 1 }));

  private copy = () => {
    const { error, stack } = this.state;
    if (!error) return;
    const entry: LoggedError = { id: 0, time: new Date(), where: `Panel: ${this.props.name}`, message: `${error.name}: ${error.message}`, stack: [error.stack, stack].filter(Boolean).join('\n\nComponent stack:') };
    const show = (copied: State['copied']) => {
      this.setState({ copied });
      window.setTimeout(() => this.setState({ copied: null }), 1500);
    };
    navigator.clipboard.writeText(errorReport([entry])).then(
      () => show('yes'),
      () => show('failed'),
    );
  };

  render() {
    const { error, copied, generation } = this.state;
    const { name, variant = 'panel', onClose } = this.props;
    if (!error) return <PanelContent key={generation}>{this.props.children}</PanelContent>;
    const card = (
      <div className={`crash crash-${variant}`} role="alert">
        <div className="crash-title">{variant === 'window' ? 'PHPBlitz hit an error' : variant === 'dialog' ? `${name} hit an error` : 'This panel hit an error'}</div>
        <div className="crash-message">{error.message || error.name}</div>
        <div className="crash-note muted">
          {variant === 'window' ? 'Try again first: reloading the window loses changes that aren’t saved.' : 'The rest of PHPBlitz keeps working.'} If it happens again, please send
          the details with a bug report.
        </div>
        <div className="crash-buttons">
          {variant === 'window' ? (
            <>
              <button type="button" className="btn small primary" onClick={this.reload}>
                Try again
              </button>
              <button type="button" className="btn small" onClick={() => window.location.reload()}>
                Reload window
              </button>
            </>
          ) : variant === 'dialog' ? (
            <button type="button" className="btn small primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <button type="button" className="btn small primary" onClick={this.reload}>
              Reload panel
            </button>
          )}
          <button type="button" className="btn small" onClick={this.copy}>
            {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy details'}
          </button>
        </div>
      </div>
    );
    return variant === 'dialog' ? <div className="modal-backdrop">{card}</div> : card;
  }
}

/** Children under a key, so Reload panel remounts them. */
function PanelContent({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
