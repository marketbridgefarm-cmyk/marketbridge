import React, { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);
const USER_CACHE_KEY = 'mb_user_cache';

function readCachedUser() {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

function cacheUser(user) {
  if (!user?.id) return;
  try {
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  } catch {
    // A full/blocked localStorage must never prevent authentication.
  }
}

function clearCachedUser() {
  try {
    localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function AuthProvider({ children }) {
  const hasToken = Boolean(localStorage.getItem('mb_token'));
  const cachedUser = hasToken ? readCachedUser() : null;
  const [user, setUser] = useState(cachedUser);
  // If we have a cached authenticated user, render immediately and validate
  // the session in the background. This removes /auth/me from the critical
  // navigation path while keeping the server as the source of truth.
  const [loading, setLoading] = useState(hasToken && !cachedUser);

  useEffect(() => {
    const token = localStorage.getItem('mb_token');
    if (!token) {
      clearCachedUser();
      setUser(null);
      setLoading(false);
      return undefined;
    }

    let active = true;

    api.get('/auth/me')
      .then((res) => {
        if (!active) return;
        const nextUser = res.data?.user || null;
        setUser(nextUser);
        cacheUser(nextUser);
      })
      .catch((error) => {
        if (!active) return;
        // A transient network/cold-start error must not log an already cached
        // user out. The API client handles genuine 401s/refresh failures.
        if (error.response?.status === 401) {
          localStorage.removeItem('mb_token');
          clearCachedUser();
          setUser(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    if (res.data.mfaRequired) {
      return { mfaRequired: true, challengeToken: res.data.challengeToken };
    }
    localStorage.setItem('mb_token', res.data.token);
    cacheUser(res.data.user);
    setUser(res.data.user);
    return res.data.user;
  };

  const completeMfaLogin = async (challengeToken, code) => {
    const res = await api.post('/auth/mfa/verify-login', { challengeToken, code });
    localStorage.setItem('mb_token', res.data.token);
    cacheUser(res.data.user);
    setUser(res.data.user);
    return res.data.user;
  };

  const register = async (data) => {
    const res = await api.post('/auth/register', data);
    localStorage.setItem('mb_token', res.data.token);
    cacheUser(res.data.user);
    setUser(res.data.user);
    return res.data.user;
  };

  const logout = async () => {
    const token = localStorage.getItem('mb_token');
    localStorage.removeItem('mb_token');
    clearCachedUser();
    setUser(null);

    try {
      if (token) await api.post('/auth/logout');
    } catch (error) {
      console.warn('Logout request failed after local session cleanup:', error);
    }
  };

  const refreshUser = async () => {
    if (!localStorage.getItem('mb_token')) return;
    try {
      const res = await api.get('/auth/me');
      const nextUser = res.data?.user || null;
      setUser(nextUser);
      cacheUser(nextUser);
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
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
