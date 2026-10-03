import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { I18nProvider } from './context/I18nContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';

import './components/Toast.css';
import './mb-tokens.css';
import './styles.css';

// Load OrderDetail CSS with the main bundle.
// This prevents Vite from creating a lazy-loaded CSS chunk
// that can fail to preload on Vercel.
import './pages/order-details/OrderDetail.css';

// ============================================================================
// Global Chunk Load Error Handler
// ----------------------------------------------------------------------------
// When Vercel deploys a new version, the old hashed .js files are deleted and
// replaced with new ones. A user with a stale cached index.html will try to
// fetch a file that no longer exists and see the "Something went wrong" crash.
//
// This handler detects that specific error, prevents the crash, and silently
// reloads the page so the browser fetches the fresh assets. It runs at most
// once per session to avoid reload loops.
// ============================================================================
const CHUNK_ERROR_PATTERNS = [
  'Failed to fetch dynamically imported module',
  'Loading chunk',
  'Loading CSS chunk',
  'ChunkLoadError',
  'Importing a module script failed',
];

function isChunkLoadError(error) {
  const message = error?.message || error?.reason?.message || '';
  return CHUNK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

const RELOAD_KEY = 'mb_chunk_reload_attempted';

function handleChunkError(event) {
  if (!isChunkLoadError(event)) return;

  event.preventDefault?.();

  // Prevent infinite reload loops: only try one auto-reload per session.
  if (sessionStorage.getItem(RELOAD_KEY) === 'true') {
    console.error('Chunk load failed twice. Not reloading again.', event);
    return;
  }

  sessionStorage.setItem(RELOAD_KEY, 'true');
  console.warn('New version detected. Reloading for fresh assets…');
  window.location.reload();
}

window.addEventListener('error', handleChunkError, true);
window.addEventListener('unhandledrejection', handleChunkError, true);

// Clear the flag once the app successfully boots so future deploys also
// get the auto-reload treatment.
window.addEventListener('load', () => {
  setTimeout(() => sessionStorage.removeItem(RELOAD_KEY), 5000);
});

// ============================================================================
// React Root
// ============================================================================

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <I18nProvider>
          <AuthProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </AuthProvider>
        </I18nProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
