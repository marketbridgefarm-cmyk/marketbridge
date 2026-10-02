import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: '' };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info?.componentStack);
    this.setState({
      error,
      componentStack: info?.componentStack || '',
    });
  }

  handleRetry = () => {
    // Clear the boundary first so a transient render/data-shape failure can
    // recover without forcing the user to close the tab.
    this.setState({ error: null, componentStack: '' });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      const message = this.state.error?.message || 'Unknown render error';
      return (
        <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: 760, margin: '0 auto' }}>
          <h1 style={{ fontSize: '1.25rem' }}>Something went wrong</h1>
          <p>Please try again. If the problem continues, use the technical details below when reporting the issue.</p>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '1rem 0' }}>
            <button type="button" onClick={this.handleRetry}>Try again</button>
            <button type="button" onClick={this.handleReload}>Refresh page</button>
          </div>

          <details>
            <summary>Technical details</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, marginTop: 12 }}>
              {message}
              {this.state.componentStack ? `\n\nComponent stack:\n${this.state.componentStack}` : ''}
            </pre>
          </details>
        </main>
      );
    }
    return this.props.children;
  }
}
