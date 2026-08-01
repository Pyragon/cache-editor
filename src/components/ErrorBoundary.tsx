import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import './ErrorBoundary.css'

// A render-time throw anywhere in the tree takes down everything above it, and
// with no boundary at all that means the whole app: a one-line indexing bug in
// one viewer left nothing on screen but the page background. React only lets a
// CLASS component catch this — there is no hook equivalent — so this is the one
// class in the codebase.
//
// Scope it per panel. The point is that the viewer that broke is the only thing
// replaced by an error, while the sidebar, the item list and the cache handle
// all carry on, so you can navigate away from the bad item instead of reloading
// and re-picking the cache folder.

type Props = {
  /** Named in the message, e.g. "viewer" → "The viewer stopped rendering". */
  label?: string
  /**
   * Changing this clears a caught error. Pass whatever identifies what is being
   * rendered (entry + item id): without it a panel that crashed once stays
   * broken for the rest of the session, because selecting a different item is
   * just a prop change to an already-errored boundary.
   */
  resetKey?: unknown
  children: ReactNode
}

type State = { error: Error | null; stack: string | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still log it: the fallback is for the user, the console is for us, and a
    // swallowed stack trace is worse than the blank page was.
    console.error(`[${this.props.label ?? 'panel'}] render failed`, error, info.componentStack)
    this.setState({ stack: info.componentStack ?? null })
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, stack: null })
    }
  }

  private retry = () => this.setState({ error: null, stack: null })

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div className="panel-error">
        <h3 className="panel-error-title">The {this.props.label ?? 'panel'} stopped rendering</h3>
        <p className="panel-error-msg">{error.message || String(error)}</p>
        <p className="panel-error-hint">
          Nothing else was affected — pick another item to carry on, and your open cache folder is still
          attached. Unsaved edits in this panel are gone.
        </p>
        <div className="panel-error-actions">
          <button type="button" className="zoom-btn" onClick={this.retry}>Try again</button>
        </div>
        {stack && (
          <details className="panel-error-details">
            <summary>Component stack</summary>
            <pre>{stack.trim()}</pre>
          </details>
        )}
      </div>
    )
  }
}
