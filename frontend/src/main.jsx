// rebuild trigger
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
