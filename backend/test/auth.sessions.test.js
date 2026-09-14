const test = require('node:test');
const assert = require('node:assert/strict');

if (process.env.MARKETBRIDGE_AUTH_SESSION_TEST !== '1') {
  test('refresh-session integration tests are opt-in', { skip: 'Set MARKETBRIDGE_AUTH_SESSION_TEST=1 with a disposable DATABASE_URL' }, () => {});
} else {
  const http = require('http');
  const bcrypt = require('bcryptjs');
  const prisma = require('../src/config/db');
  const app = require('../src/index').app;

  let server;
  let baseUrl;
  let email;
  let user;

  async function jsonRequest(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options,
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
    return { status: response.status, body: await response.json() };
  }

  test.before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    email = `auth-session-${Date.now()}@example.test`;
    user = await prisma.user.create({
      data: {
        name: 'Auth Session Test',
        email,
        passwordHash: await bcrypt.hash('password123', 12),
        roles: ['BUYER', 'SELLER'],
      },
    });
  });

  test('login creates a persistent refresh session', async () => {
    const res = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    assert.equal(res.status, 200);
    assert.ok(res.body.refreshToken);
    assert.ok(res.body.token);

    const sessions = await prisma.refreshSession.findMany({ where: { userId: user.id } });
    assert.ok(sessions.length >= 1);
    assert.ok(sessions.some((s) => s.revokedAt === null));
  });

  test('refresh rotates the session and old refresh token cannot be reused', async () => {
    const login = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    const oldRefresh = login.body.refreshToken;

    const refreshed = await jsonRequest('/api/auth/refresh', { method: 'POST', body: { refreshToken: oldRefresh } });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.refreshToken, oldRefresh);

    const replay = await jsonRequest('/api/auth/refresh', { method: 'POST', body: { refreshToken: oldRefresh } });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'REFRESH_SESSION_REVOKED');
  });

  test('logout-all revokes all active sessions', async () => {
    const login = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    const res = await jsonRequest('/api/auth/logout-all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.revokedSessions >= 1);

    const refresh = await jsonRequest('/api/auth/refresh', { method: 'POST', body: { refreshToken: login.body.refreshToken } });
    assert.equal(refresh.status, 401);
  });

  test('logout revokes the current session and its access token', async () => {
    const login = await jsonRequest('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    const logout = await jsonRequest('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(logout.status, 200);

    const me = await jsonRequest('/api/auth/me', {
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(me.status, 401);
    assert.equal(me.body.code, 'SESSION_REVOKED');
  });

  test.after(async () => {
    await prisma.refreshSession.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });
}
