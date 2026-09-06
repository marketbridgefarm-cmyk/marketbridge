import React, { useEffect, useState } from 'react';
import api from '../api/client';

export default function PaymentPanel({
  type = 'MARKETPLACE',
  orderId,
  amount,
  transportJobId,
  inspectionRequestId,
  digitalProductId,
  advertisementId,
  onPaid,
}) {
  const [methods, setMethods] = useState([]);
  const [method, setMethod] = useState('TELEBIRR');
  const [phone, setPhone] = useState('');
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let mounted = true;

    async function loadMethods() {
      try {
        const response = await api.get('/payments/methods');

        if (!mounted) return;

        const returnedMethods = Array.isArray(response.data)
          ? response.data
          : Array.isArray(response.data?.methods)
            ? response.data.methods
            : [];

        setMethods(returnedMethods);

        const telebirr = returnedMethods.find(
          (item) =>
            String(item?.code || item?.value || item?.method || item)
              .toUpperCase() === 'TELEBIRR'
        );

        if (telebirr) {
          setMethod(
            telebirr.code ||
            telebirr.value ||
            telebirr.method ||
            'TELEBIRR'
          );
        } else if (returnedMethods.length > 0) {
          const first = returnedMethods[0];

          setMethod(
            typeof first === 'string'
              ? first
              : first.code || first.value || first.method || 'TELEBIRR'
          );
        }
      } catch (err) {
        /*
         * The payment methods endpoint is useful for discovery,
         * but Telebirr is the configured MarketBridge test method.
         * Keep the UI usable if the discovery endpoint is unavailable.
         */
        if (mounted) {
          setMethods([]);
          setMethod('TELEBIRR');
        }
      } finally {
        if (mounted) setLoadingMethods(false);
      }
    }

    loadMethods();

    return () => {
      mounted = false;
    };
  }, []);

  function getMethodValue(item) {
    if (typeof item === 'string') return item;

    return (
      item?.code ||
      item?.value ||
      item?.method ||
      item?.name ||
      ''
    );
  }

  async function pay() {
    setError('');
    setMessage('');

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError('Invalid payment amount.');
      return;
    }

    if (!orderId && type !== 'ADVERTISING' && type !== 'INSPECTOR') {
      setError('Order information is missing.');
      return;
    }

    setPaying(true);

    try {
      /*
       * Step 1:
       * Create a PENDING payment record on MarketBridge.
       *
       * The server remains authoritative for payment status.
       * The browser never marks the payment PAID.
       */
      const createResponse = await api.post('/payments', {
        type,
        amount: numericAmount,
        method,
        orderId,
        transportJobId,
        inspectionRequestId,
        digitalProductId,
        advertisementId,
      });

      const payment =
        createResponse.data?.payment ||
        createResponse.data;

      if (!payment?.id) {
        throw new Error('The server did not return a payment ID.');
      }

      /*
       * QR/OTHER may only create a payment record.
       * Chapa-backed methods continue to initiation below.
       */
      if (
        method === 'QR' ||
        method === 'OTHER'
      ) {
        setMessage(
          'Payment record created. Complete the configured payment process and wait for verification.'
        );

        if (typeof onPaid === 'function') {
          await onPaid(payment);
        }

        return;
      }

      /*
       * Step 2:
       * Ask the backend to initiate the provider checkout.
       */
      const initiateResponse = await api.post(
        `/payments/${payment.id}/initiate`,
        {
          phone:
            method === 'CBE'
              ? phone.trim() || undefined
              : undefined,
        }
      );

      const data = initiateResponse.data || {};

      const checkoutUrl =
        data.checkoutUrl ||
        data.checkout_url ||
        data.paymentUrl ||
        data.payment_url ||
        data.data?.checkoutUrl ||
        data.data?.checkout_url ||
        data.data?.paymentUrl ||
        data.data?.payment_url;

      if (checkoutUrl) {
        /*
         * Leave the SPA and open the provider checkout.
         * Chapa/Telebirr returns to the configured MarketBridge
         * payment-return route after checkout.
         */
        window.location.assign(checkoutUrl);
        return;
      }

      /*
       * Some development/test providers may create the payment
       * without returning a browser checkout URL.
       */
      setMessage(
        data.message ||
        'Payment was created successfully. Waiting for payment verification.'
      );

      if (typeof onPaid === 'function') {
        await onPaid(payment);
      }
    } catch (err) {
      const responseData = err.response?.data;

      setError(
        responseData?.error ||
        responseData?.message ||
        err.message ||
        'Could not start the payment.'
      );
    } finally {
      setPaying(false);
    }
  }

  const numericAmount = Number(amount);

  return (
    <div className="payment-panel">
      <div className="row-between">
        <div>
          <h2>
            {type === 'TRANSPORT'
              ? 'Pay transport fee'
              : type === 'MARKETPLACE'
                ? 'Pay for your order'
                : 'Make payment'}
          </h2>

          <p className="muted">
            Amount:{' '}
            <strong>
              {Number.isFinite(numericAmount)
                ? numericAmount.toLocaleString()
                : '0'}{' '}
              ETB
            </strong>
          </p>
        </div>

        <span className="badge">
          {type}
        </span>
      </div>

      <div className="notice">
        <strong>Test payment</strong>
        <br />
        Telebirr through Chapa is currently configured for
        MarketBridge development/testing. No live-money payment
        should be assumed from this test flow.
      </div>

      {error && (
        <div className="alert error">
          {error}
        </div>
      )}

      {message && (
        <div className="alert success">
          {message}
        </div>
      )}

      <div className="form-group">
        <label htmlFor={`payment-method-${type}`}>
          Payment method
        </label>

        {loadingMethods ? (
          <div className="muted">
            Loading payment methods…
          </div>
        ) : methods.length > 0 ? (
          <select
            id={`payment-method-${type}`}
            value={method}
            onChange={(event) =>
              setMethod(event.target.value)
            }
            disabled={paying}
          >
            {methods.map((item, index) => {
              const value = getMethodValue(item);

              if (!value) return null;

              return (
                <option
                  key={`${value}-${index}`}
                  value={value}
                >
                  {value === 'TELEBIRR'
                    ? 'Telebirr via Chapa'
                    : value}
                </option>
              );
            })}
          </select>
        ) : (
          <select
            id={`payment-method-${type}`}
            value={method}
            onChange={(event) =>
              setMethod(event.target.value)
            }
            disabled={paying}
          >
            <option value="TELEBIRR">
              Telebirr via Chapa
            </option>
          </select>
        )}
      </div>

      {method === 'CBE' && (
        <div className="form-group">
          <label htmlFor={`payment-phone-${type}`}>
            Phone number
          </label>

          <input
            id={`payment-phone-${type}`}
            type="tel"
            value={phone}
            onChange={(event) =>
              setPhone(event.target.value)
            }
            placeholder="Optional phone number"
            disabled={paying}
          />
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        onClick={pay}
        disabled={paying || !Number.isFinite(numericAmount) || numericAmount <= 0}
      >
        {paying
          ? 'Starting payment…'
          : type === 'TRANSPORT'
            ? 'Pay transport fee'
            : 'Pay your order'}
      </button>
    </div>
  );
}
