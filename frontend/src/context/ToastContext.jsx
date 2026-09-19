import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const showToast = useCallback((message, type = 'info', duration = 4200) => {
    if (!message) return null;
    const id = makeId();
    setToasts((current) => [...current.slice(-3), { id, message: String(message), type }]);
    const timer = setTimeout(() => dismissToast(id), duration);
    timers.current.set(id, timer);
    return id;
  }, [dismissToast]);

  useEffect(() => () => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
  }, []);

  const value = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="mb-toast-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`mb-toast mb-toast--${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>
            <span className="mb-toast-icon" aria-hidden="true">
              {toast.type === 'success' ? '✓' : toast.type === 'error' ? '!' : 'i'}
            </span>
            <span className="mb-toast-message">{toast.message}</span>
            <button type="button" className="mb-toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss message">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
