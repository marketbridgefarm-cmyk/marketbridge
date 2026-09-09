import axios from 'axios';

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, '');
const baseURL = configuredApiUrl ? `${configuredApiUrl}/api` : '/api';

const SUSPENDED_MESSAGE = 'This account has been suspended. Contact support for assistance.';

const api = axios.create({ baseURL });

// Separate plain axios instance (no interceptors) for the refresh call
// itself, so a failed refresh can't recursively trigger this same
// response interceptor and loop.
const refreshClient = axios.create({ baseURL });

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
  localStorage.removeItem('mb_refresh_token');
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
    const storedRefreshToken = localStorage.getItem('mb_refresh_token');

    if (!storedRefreshToken) {
      refreshPromise = Promise.reject(new Error('No refresh token available'));
    } else {
      refreshPromise = refreshClient
        .post('/auth/refresh', { refreshToken: storedRefreshToken })
        .then((res) => {
          localStorage.setItem('mb_token', res.data.token);
          localStorage.setItem('mb_refresh_token', res.data.refreshToken);
          return res.data.token;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
  }

  return refreshPromise;
}

// If the session is no longer valid (expired/invalid token, or the account
// has been suspended since the token was issued), try a silent refresh
// first — the backend issues a 7-day refresh token specifically so a
// short-lived (15m default) access token doesn't force active users back
// to the login screen. Only fall back to clearing the session and
// redirecting to /login if the refresh itself fails (refresh token
// missing, expired, or the account is suspended). Other 403s are ordinary
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
    // if the refresh token itself is invalid).
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

export default api;      const serverMessage = error.response?.data?.error;
      const isSuspended = status === 403 && serverMessage === SUSPENDED_MESSAGE;
      const isSessionInvalid = status === 401;

      if ((isSuspended || isSessionInvalid) && localStorage.getItem('mb_token')) {
        localStorage.removeItem('mb_token');

        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = `/login?session=${isSuspended ? 'suspended' : 'expired'}`;
        }
      }
    }

    return Promise.reject(error);
  }
);

export default api;
