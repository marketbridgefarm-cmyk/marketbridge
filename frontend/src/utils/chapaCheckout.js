import api from '../api/client';

/**
 * Initialize an existing MarketBridge payment with Chapa
 * and redirect the browser to Chapa's hosted checkout page.
 */
export async function chapaInitializeAndRedirect(paymentId) {
  if (!paymentId) {
    throw new Error('Payment was not created');
  }

  try {
    const { data } = await api.post(
      `/payments/${paymentId}/chapa/initialize`
    );

    const checkoutUrl = data?.checkoutUrl;

    if (!checkoutUrl) {
      throw new Error('Could not start Chapa checkout');
    }

    // Redirect to Chapa's hosted payment page.
    window.location.assign(checkoutUrl);
  } catch (error) {
    const message =
      error?.response?.data?.error ||
      error?.message ||
      'Could not start Chapa checkout';

    const enhancedError = new Error(message);

    // Preserve useful Axios information for callers/logging.
    enhancedError.response = error?.response;
    enhancedError.status = error?.response?.status;

    throw enhancedError;
  }
}

/**
 * Create a MarketBridge payment intent and then
 * initialize Chapa hosted checkout.
 *
 * Supported payment types include:
 * - MARKETPLACE
 * - TRANSPORT
 * - INSPECTOR
 * - ADVERTISING
 * - DIGITAL
 *
 * The caller is responsible for supplying the appropriate
 * payment payload and authorization context.
 */
// PDF recommendation #14 (Idempotency & Concurrency). One key per
// "create this payment intent" attempt: a page refresh mid-request, a
// double-tapped pay button, or an axios retry on a flaky connection all
// resend the exact same request, and the key lets the backend recognize
// the retry and hand back the original payment instead of creating a
// second one. crypto.randomUUID() is available in every browser this app
// already targets (same API level Chapa checkout redirects require); the
// timestamp+random fallback only matters for very old browsers/webviews.
function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function startChapaPayment(paymentPayload) {
  if (!paymentPayload || typeof paymentPayload !== 'object') {
    throw new Error('Payment information is required');
  }

  try {
    const { data } = await api.post(
      '/payments',
      paymentPayload,
      { headers: { 'Idempotency-Key': newIdempotencyKey() } }
    );

    const paymentId = data?.payment?.id;

    if (!paymentId) {
      throw new Error(
        data?.error ||
        'Payment intent was not created'
      );
    }

    await chapaInitializeAndRedirect(paymentId);

    // Normally this function never reaches here because
    // the browser is redirected to Chapa.
    return {
      payment: data.payment,
      checkoutUrl: data.checkoutUrl || null,
    };
  } catch (error) {
    const message =
      error?.response?.data?.error ||
      error?.message ||
      'Could not create payment';

    const enhancedError = new Error(message);

    enhancedError.response = error?.response;
    enhancedError.status = error?.response?.status;

    throw enhancedError;
  }
}
