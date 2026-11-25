// The API returns a relative path like /api/users/<id>/avatar?v=abc. The web app and the API can live on
// different origins (Vercel + Render), so <img> needs the API origin in front of it.
export function apiOrigin() {
  const url = import.meta.env?.VITE_API_URL;
  return typeof url === 'string' ? url.trim().replace(/\/$/, '') : '';
}

export function resolveAvatarUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  return `${apiOrigin()}${url.startsWith('/') ? url : `/${url}`}`;
}
