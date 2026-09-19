import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface it somewhere visible in prod builds instead of a silent blank page.
    console.error('Unhandled render error:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: 560, margin: '0 auto' }}>
          <h1 style={{ fontSize: '1.25rem' }}>Something went wrong</h1>
          <p>Please refresh the page. If the problem continues, contact support.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
