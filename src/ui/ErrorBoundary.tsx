import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/reportError';

/**
 * What stands in for the page when its code throws.
 *
 * React unmounts the whole tree when a render throws, and this page's
 * background is near black, so a crash looked like the window going dark
 * with nothing to say — twice, before anyone knew why. Now the error is
 * said where the page was, with the stack, and written to the launch log
 * beside the server's own lines so it can be read from outside too.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; info?: string }> {
  state: { error: Error | null; info?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? undefined });
    reportError('render', error, info.componentStack ?? undefined);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: '32px 24px', maxWidth: 820, margin: '0 auto', color: 'var(--text)' }}>
        <h2 style={{ marginTop: 0 }}>The studio's page stopped</h2>
        <p style={{ color: 'var(--text-dim)' }}>
          Something in the page threw while drawing. The error is below and in the launch log; reload
          to try again.
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-raised)', padding: 12, borderRadius: 8, fontSize: 12.5 }}>
          {`${error.name}: ${error.message}\n${error.stack ?? ''}${info ? `\n\ncomponent stack:${info}` : ''}`}
        </pre>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
