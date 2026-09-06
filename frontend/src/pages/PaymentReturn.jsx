import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api/client';

export default function PaymentReturn() {
  const { paymentId } = useParams();
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const r = await api.get(`/payments/${paymentId}/chapa/verify`);
        if (!cancelled) setStatus(r.data?.status || 'PENDING');
      } catch (e) {
        if (!cancelled) {
          setError(e.response?.data?.error || 'Could not verify payment');
          setStatus('ERROR');
        }
      }
    }

    check();
    return () => { cancelled = true; };
  }, [paymentId]);

  return (
    <main className="section">
      <div className="container-narrow">
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          {status === 'checking' && <p>Confirming your payment with Chapa…</p>}

          {status === 'PAID' && (
            <>
              <h2>Payment confirmed ✓</h2>
              <p className="muted">Your payment has been verified and recorded.</p>
            </>
          )}

          {status === 'PENDING' && (
            <>
              <h2>Payment pending</h2>
              <p className="muted">
                Chapa hasn't confirmed this payment yet. If you completed checkout,
                this usually clears within a minute — refresh this page to check again.
              </p>
              <button className="btn btn-light" onClick={() => window.location.reload()}>
                Check again
              </button>
            </>
          )}

          {status === 'FAILED' && (
            <>
              <h2>Payment failed</h2>
              <p className="muted">Chapa reported this payment did not succeed. No charge should have been made.</p>
            </>
          )}

          {status === 'ERROR' && (
            <>
              <h2>Couldn't verify payment</h2>
              <p className="muted">{error}</p>
            </>
          )}

          <Link to="/" className="btn btn-primary" style={{ marginTop: 20, display: 'inline-block' }}>
            Back to MarketBridge
          </Link>
        </div>
      </div>
    </main>
  );
}
