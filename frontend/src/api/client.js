import axios from 'axios';

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, '');
const baseURL = configuredApiUrl ? `${configuredApiUrl}/api` : '/api';

const SUSPENDED_MESSAGE = 'This account has been suspended. Contact support for assistance.';

// withCredentials: true is required so the browser sends/accepts the
// HttpOnly refresh-token cookie set by the backend (routes/auth.js). The
// refresh token itself is never touched by JS — it lives only in that
// cookie, scoped to /api/auth, and is invisible to this code and to any
// XSS running on the page.
const api = axios.create({ baseURL, withCredentials: true });

// Separate plain axios instance (no interceptors) for the refresh call
// itself, so a failed refresh can't recursively trigger this same
// response interceptor and loop. Refresh tokens are persistent, rotated
// server-side sessions; every successful refresh replaces the cookie.
const refreshClient = axios.create({ baseURL, withCredentials: true });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('mb_token');

  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

function clearSession() {
  localStorage.removeItem('mb_token');
}

function goToLogin(reason) {
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = `/login?session=${reason}`;
  }
}

// While a refresh is in flight, every other request that also 401s queues
// up here instead of firing its own /auth/refresh call. They're all
// resolved/rejected together once the single in-flight refresh settles.
let refreshPromise = null;

function refreshSession() {
  if (!refreshPromise) {
    // No refresh token to read or send here — it's an HttpOnly cookie the
    // browser attaches automatically to this same-origin-scoped request.
    refreshPromise = refreshClient
      .post('/auth/refresh')
      .then((res) => {
        localStorage.setItem('mb_token', res.data.token);
        return res.data.token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

// If the session is no longer valid (expired/invalid token, or the account
// has been suspended since the token was issued), try a silent refresh
// first — the backend issues a 7-day refresh session specifically so a
// short-lived (15m default) access token doesn't force active users back
// to the login screen. Only fall back to clearing the session and
// redirecting to /login if the persistent refresh session itself fails
// (missing, expired, revoked, or the account is suspended). Other 403s are ordinary
// "you're not allowed to do this one thing" authorization denials and
// must NOT trigger a refresh or a logout.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const config = error.config || {};
    const url = config.url || '';
    const isAuthEndpoint =
      url.includes('/auth/login') ||
      url.includes('/auth/register') ||
      url.includes('/auth/refresh');

    if (isAuthEndpoint) {
      return Promise.reject(error);
    }

    // Some backend validation failures respond with only an express-validator
    // `{ errors: [...] }` array and no top-level `error`/`message` string
    // (most such routes now set one too, but this is a safety net for any
    // that don't, present or future). Without this, every `.response.data.error`
    // read across the app comes back undefined and callers fall through to
    // axios's generic "Request failed with status code 4xx", which tells the
    // user nothing about what actually went wrong.
    if (error.response?.data && !error.response.data.error && Array.isArray(error.response.data.errors) && error.response.data.errors.length) {
      const firstError = error.response.data.errors[0];
      error.response.data.error = firstError?.msg || firstError?.message || 'Validation failed';
    }

    const serverMessage = error.response?.data?.error;
    const isSuspended = status === 403 && serverMessage === SUSPENDED_MESSAGE;

    if (isSuspended) {
      if (localStorage.getItem('mb_token')) {
        clearSession();
        goToLogin('suspended');
      }
      return Promise.reject(error);
    }

    // Only attempt a refresh on a genuine 401, and only once per request
    // (config._retried guards against a refreshed-but-still-401 loop, e.g.
    // if the refresh cookie itself is invalid).
    if (status === 401 && !config._retried && localStorage.getItem('mb_token')) {
      config._retried = true;

      try {
        const newToken = await refreshSession();
        config.headers = config.headers || {};
        config.headers.Authorization = `Bearer ${newToken}`;
        return api.request(config);
      } catch (refreshError) {
        clearSession();
        goToLogin('expired');
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
