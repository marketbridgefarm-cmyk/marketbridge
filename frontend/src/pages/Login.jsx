import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const SESSION_MESSAGES = {
  suspended: 'This account has been suspended. Contact support for assistance.',
  expired: 'Your session has ended. Please log in again.',
};

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const sessionReason = searchParams.get('session');
  const sessionMessage = sessionReason && SESSION_MESSAGES[sessionReason];

  async function submit(e) {
    e.preventDefault();
    try {
      const u = await login(email, password);
      const path = u.roles?.includes('SELLER')
        ? '/dashboard/seller'
        : u.roles?.includes('BUYER')
        ? '/dashboard/buyer'
        : u.roles?.includes('INSPECTOR')
        ? '/dashboard/inspector'
        : u.roles?.includes('TRUCK_OWNER')
        ? '/dashboard/truck-owner'
        : '/';
      nav(path);
    } catch (e) {
      const data = e.response?.data;
      const msg = data?.error || data?.errors?.[0]?.msg || 'Login failed';
      setError(msg);
    }
  }

  return (
    <main className="section auth-section">
      <div className="auth-card card">
        <span className="eyebrow">WELCOME BACK</span>
        <h1>Log in to MarketBridge.</h1>
        {sessionMessage && !error && <div className="alert error">{sessionMessage}</div>}
        {error && <div className="alert error">{error}</div>}
        <form onSubmit={submit}>
          <label>Email</label>
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label>Password</label>
          <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn btn-primary full" type="submit">Log in</button>
        </form>
        <p className="muted">New to MarketBridge? <Link to="/register">Create an account</Link></p>
      </div>
    </main>
  );
}
