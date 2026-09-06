import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';

export default function PaymentResult() {
  const [params] = useSearchParams();
  const reference = params.get('payment') || params.get('tx_ref') || params.get('trx_ref') || params.get('reference');
  const [state, setState] = useState({ loading: true, status: '', message: 'Checking payment status…' });

  useEffect(() => {
    let cancelled = false;
    async function checkPayment() {
      if (!reference) { setState({ loading: false, status: 'UNKNOWN', message: 'No payment reference was supplied.' }); return; }
      try {
        const response = await api.get('/payments/lookup-by-reference', { params: { reference } });
        if (cancelled) return;
        const payment = response.data?.payment;
        const status = String(payment?.status || 'PENDING').toUpperCase();
        if (status === 'PAID') setState({ loading: false, status: 'PAID', message: 'Payment confirmed successfully.' });
        else if (status === 'FAILED') setState({ loading: false, status: 'FAILED', message: 'The payment was not successful.' });
        else if (status === 'REFUNDED') setState({ loading: false, status: 'REFUNDED', message: 'This payment has been refunded.' });
        else setState({ loading: false, status, message: 'Payment is still being verified.' });
      } catch (err) {
        if (cancelled) return;
        setState({ loading: false, status: 'PENDING', message: 'Payment is being verified. Please check your order shortly.' });
      }
    }
    checkPayment();
    return () => { cancelled = true; };
  }, [reference]);

  return (
    <main className="section">
      <div className="container-narrow">
        <div className="card form-card">
          <span className="eyebrow">PAYMENT</span>
          <h1>{state.message}</h1>
          {reference && <p className="muted">Reference: <strong>{reference}</strong></p>}
          {state.status === 'PAID' && <div className="alert success">Your payment has been verified by MarketBridge.</div>}
          {state.status === 'FAILED' && <div className="alert error">The provider reported that the payment was not successful.</div>}
          {state.status === 'PENDING' && <div className="notice">The provider return page is only a navigation signal. MarketBridge waits for verified payment confirmation before changing the payment to PAID.</div>}
          <div className="row-actions" style={{ marginTop: 18 }}>
            <Link className="btn btn-primary" to="/orders">Go to My Orders</Link>
            <Link className="btn btn-light" to="/dashboard/buyer">Buyer Dashboard</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
