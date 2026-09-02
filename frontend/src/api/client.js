import axios from 'axios';

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, '');

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

export default api;
