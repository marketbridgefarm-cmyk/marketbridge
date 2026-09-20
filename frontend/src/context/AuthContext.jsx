import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('mb_token');
    if (token) {
      api.get('/auth/me')
        .then(res => setUser(res.data.user))
        .catch(() => {
          localStorage.removeItem('mb_token');
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    if (res.data.mfaRequired) {
      // Caller (Login.jsx) is responsible for collecting a code and calling
      // completeMfaLogin — no token exists yet, so nothing to store here.
      return { mfaRequired: true, challengeToken: res.data.challengeToken };
    }
    localStorage.setItem('mb_token', res.data.token);
    setUser(res.data.user);
    return res.data.user;
  };

  const completeMfaLogin = async (challengeToken, code) => {
    const res = await api.post('/auth/mfa/verify-login', { challengeToken, code });
    localStorage.setItem('mb_token', res.data.token);
    setUser(res.data.user);
    return res.data.user;
  };

  const register = async (data) => {
    const res = await api.post('/auth/register', data);
    localStorage.setItem('mb_token', res.data.token);
    setUser(res.data.user);
    return res.data.user;
  };

  const logout = async () => {
    const token = localStorage.getItem('mb_token');

    // Clear the local session immediately so authenticated UI (including the
    // sidebar) disappears without waiting for the server request.
    localStorage.removeItem('mb_token');
    setUser(null);

    try {
      if (token) {
        await api.post('/auth/logout');
      }
    } catch (error) {
      // The local session is already cleared; the server may already have
      // expired the session or the request may simply have failed.
      console.warn('Logout request failed after local session cleanup:', error);
    }
  };

  const refreshUser = async () => {
    if (!localStorage.getItem('mb_token')) return;
    try {
      const res = await api.get('/auth/me');
      setUser(res.data.user);
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, completeMfaLogin, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
