import axios from 'axios';

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, '');

const SUSPENDED_MESSAGE = 'This account has been suspended. Contact support for assistance.';

const api = axios.create({
  baseURL: configuredApiUrl ? `${configuredApiUrl}/api` : '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('mb_token');

  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// If the session is no longer valid (expired/invalid token, or the account
// has been suspended since the token was issued), clear it and send the
// user to login with an explanation — instead of leaving them stuck seeing
// silent errors on every request. Only 401 (always a session problem here)
// and the specific suspended-account 403 trigger this; other 403s are
// ordinary "you're not allowed to do this one thing" authorization denials
// and must NOT log the user out.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register');

    if (!isAuthEndpoint) {
      const serverMessage = error.response?.data?.error;
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
