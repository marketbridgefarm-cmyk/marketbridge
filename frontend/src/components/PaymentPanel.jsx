import React, { useEffect, useState } from 'react';
import api from '../api/client';

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : '0.00';
}

export default function PaymentPanel({
  type = 'MARKETPLACE',
  orderId,
  transportJobId,
  inspectionRequestId,
  digitalProductId,
  advertisementId,
  amount,
  onPaid,
}) {
  const [methods, setMethods] = useState([]);
  const [method, setMethod] = useState('TELEBIRR');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadMethods() {
      try {
        const response = await api.get('/payments/methods');

        if (cancelled) return;

        const available = Array.isArray(response.data?.methods)
          ? response.data.methods
          : [];

        setMethods(available);

        /*
         * Telebirr is the current MarketBridge test payment method.
         * Prefer it whenever the backend advertises it.
         */
        const telebirr = available.find(
          (item) =>
            String(item.id || '').toUpperCase() === 'TELEBIRR'
        );

        if (telebirr) {
          setMethod('TELEBIRR');
        } else if (available.length > 0) {
          setMethod(available[0].id);
        }
      } catch (err) {
        /*
         * Do not hide the payment button merely because the methods
         * discovery endpoint failed. The backend payment endpoint
         * remains authoritative.
         */
        if (!cancelled) {
          setMethods([]);
          setMethod('TELEBIRR');
        }
      } finally {
        if (!cancelled) {
          setLoadingMethods(false);
        }
      }
    }

    loadMethods();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedMethod = methods.find(
    (item) =>
      String(item.id || '').toUpperCase() ===
      String(method || '').toUpperCase()
  );

  async function startPayment() {
    if (busy) return;

    setBusy(true);
    setError('');
    setNotice('');

    try {
      /*
       * Step 1:
       * Create a PENDING payment record.
       *
       * This request does NOT mark the payment as PAID.
       */
      const createResponse = await api.post('/payments', {
        type,
        amount: Number(amount),
        method,
        orderId,
        transportJobId,
        inspectionRequestId,
        digitalProductId,
        advertisementId,
      });

      const payment = createResponse.data?.payment;

      if (!payment?.id) {
        throw new Error('Payment record was not created by the server.');
      }

      /*
       * Manual/record-only methods do not have a gateway checkout.
       */
      if (method === 'QR' || method === 'OTHER') {
        setNotice(
          'Payment record created. This payment requires authorized reconciliation.'
        );

        onPaid?.(payment);
        return;
      }

      /*
       * Step 2:
       * Ask the backend to create the provider checkout.
       *
       * For Telebirr, the current backend integrates the provider
       * through the configured payment service.
       */
      const initiateResponse = await api.post(
        `/payments/${payment.id}/initiate`,
        {
          phone: method === 'CBE' ? phone.trim() || undefined : undefined,
        }
      );

      const data = initiateResponse.data || {};

      const checkoutUrl =
        data.checkoutUrl ||
        data.checkout_url ||
        data.paymentUrl ||
        data.payment_url;

      if (!checkoutUrl) {
        /*
         * Some provider integrations may return the updated payment
         * without a browser checkout URL.
         */
        if (data.payment) {
          onPaid?.(data.payment);
        }

        throw new Error(
          'The payment was created, but the payment provider did not return a checkout URL.'
        );
      }

      /*
       * Step 3:
       * Leave MarketBridge and open the provider checkout.
       *
       * The provider/webhook must later confirm the payment.
       */
      window.location.assign(checkoutUrl);
    } catch (err) {
      const serverError =
        err.response?.data?.error ||
        err.response?.data?.message ||
        err.message ||
        'Payment could not be started.';

      setError(serverError);
    } finally {
      setBusy(false);
    }
  }

  const isChapaTestPayment =
    String(method).toUpperCase() === 'TELEBIRR';

  return (
    <div className="card payment-panel">
      <span className="eyebrow">
        {type === 'TRANSPORT' ? 'TRANSPORT PAYMENT' : 'PAYMENT REQUIRED'}
      </span>

      <h2>
        {type === 'TRANSPORT'
          ? 'Pay transport fee'
          : 'Pay your order'}
      </h2>

      <p className="muted">
        Amount:{' '}
        <strong>{formatMoney(amount)} ETB</strong>
      </p>

      {type === 'MARKETPLACE' && (
        <div className="notice">
          Your order must be paid before transport can proceed.
          MarketBridge will only confirm the order after the payment
          provider verifies the transaction.
        </div>
      )}

      {type === 'TRANSPORT' && (
        <div className="notice">
          This payment is for the accepted transporter quote. The
          transporter cannot proceed until this payment is verified.
        </div>
      )}

      <label>
        Payment method
        <select
          value={method}
          onChange={(event) => {
            setMethod(event.target.value);
            setError('');
            setNotice('');
          }}
          disabled={busy}
        >
          {methods.length > 0 ? (
            methods.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label || item.id}
                {item.manual ? ' (manual)' : ''}
              </option>
            ))
          ) : (
            <option value="TELEBIRR">
              Telebirr via Chapa
            </option>
          )}
        </select>
      </label>

      {selectedMethod?.description && (
        <p className="muted small">
          {selectedMethod.description}
        </p>
      )}

      {method === 'CBE' && (
        <label>
          Phone number
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="2519..."
            inputMode="tel"
            disabled={busy}
          />
        </label>
      )}

      {isChapaTestPayment && (
        <div className="notice">
          <strong>Test payment:</strong> Telebirr is being used
          through the configured Chapa test integration. No live-money
          payment should be assumed from this development flow.
        </div>
      )}

      {error && (
        <div className="alert error">
          {error}
        </div>
      )}

      {notice && (
        <div className="alert success">
          {notice}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-lg full"
        disabled={busy || loadingMethods || !method}
        onClick={startPayment}
      >
        {busy
          ? 'Starting payment…'
          : type === 'TRANSPORT'
          ? 'Pay transport fee'
          : 'Pay your order'}
      </button>

      <p className="muted small" style={{ marginTop: 12 }}>
        Your payment is first recorded as pending. Only a verified
        provider callback or authorized reconciliation can change it
        to PAID.
      </p>
    </div>
  );
}
