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

  // Shared by password login, register, and a completed MFA challenge —
  // all three end the same way: store the access token, set the user.
  const completeSession = (data) => {
    localStorage.setItem('mb_token', data.token);
    setUser(data.user);
    return data.user;
  };

  // Admin accounts with MFA enabled don't get a session back from
  // /auth/login — they get { mfaRequired, challengeId, methods } instead.
  // The caller (Login page) is responsible for noticing that shape and
  // walking the user through verifyMfa() before a session exists.
  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    if (res.data?.mfaRequired) {
      return res.data;
    }
    return completeSession(res.data);
  };

  const requestMfaEmailCode = async (challengeId) => {
    await api.post('/auth/mfa/challenge/email', { challengeId });
  };

  const verifyMfa = async (challengeId, code, method) => {
    const res = await api.post('/auth/mfa/verify', { challengeId, code, method });
    return completeSession(res.data);
  };

  const register = async (data) => {
    const res = await api.post('/auth/register', data);
    return completeSession(res.data);
  };

  const logout = async () => {
    try {
      if (localStorage.getItem('mb_token')) {
        await api.post('/auth/logout');
      }
    } catch (error) {
      // Local cleanup still happens if the network/session is already gone.
      console.warn('Logout request failed; clearing local session:', error);
    } finally {
      localStorage.removeItem('mb_token');
      setUser(null);
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
    <AuthContext.Provider
      value={{ user, loading, login, requestMfaEmailCode, verifyMfa, register, logout, refreshUser }}
    >
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
