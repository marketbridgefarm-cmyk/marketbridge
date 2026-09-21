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

    window.location.assign(checkoutUrl);
  } catch (error) {
    const message =
      error?.response?.data?.error ||
      error?.response?.data?.message ||
      error?.message ||
      'Could not start Chapa checkout';

    const enhancedError = new Error(message);

    enhancedError.response = error?.response;
    enhancedError.status = error?.response?.status;

    throw enhancedError;
  }
}

/**
 * Create a payment intent and start Chapa checkout.
 *
 * IMPORTANT:
 * If the backend says an active payment already exists,
 * reuse that payment instead of treating the response as a
 * fatal error. This prevents duplicate payments and allows
 * the buyer to continue the existing checkout.
 */
function newIdempotencyKey() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return `idem-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export async function startChapaPayment(paymentPayload) {
  if (!paymentPayload || typeof paymentPayload !== 'object') {
    throw new Error('Payment information is required');
  }

  try {
    const { data } = await api.post(
      '/payments',
      paymentPayload,
      {
        headers: {
          'Idempotency-Key': newIdempotencyKey(),
        },
      }
    );

    const paymentId = data?.payment?.id;

    if (!paymentId) {
      throw new Error(
        data?.error ||
          data?.message ||
          'Payment intent was not created'
      );
    }

    /*
     * Normal path:
     *
     * New payment → initialize → Chapa checkout.
     */
    await chapaInitializeAndRedirect(paymentId);

    return {
      payment: data.payment,
      checkoutUrl: data.checkoutUrl || null,
    };
  } catch (error) {
    /*
     * The backend deliberately returns 409 when an active
     * payment already exists. That is not a reason to make
     * the buyer create another payment.
     *
     * Reuse the existing payment returned by the backend.
     */
    const existingPayment =
      error?.response?.data?.payment || null;

    if (
      error?.response?.status === 409 &&
      existingPayment?.id
    ) {
      const status = existingPayment.status;

      /*
       * PENDING means the payment has not yet been sent
       * to Chapa. Start its existing checkout.
       */
      if (status === 'PENDING') {
        await chapaInitializeAndRedirect(
          existingPayment.id
        );

        return {
          payment: existingPayment,
          checkoutUrl: null,
          reused: true,
        };
      }

      /*
       * PROCESSING means a Chapa initialization has already
       * started. Do not create another payment or initialize
       * it again.
       *
       * The order page can use its existing verification flow.
       *
       * IMPORTANT: callers read the display message via
       * error.response.data.error (see getError() in the pages
       * that use this), not error.message — so the friendly
       * text has to be written into response.data.error too, or
       * it never reaches the user and they see the raw backend
       * string ("Active payment already exists") with no
       * indication of what to do next.
       */
      if (status === 'PROCESSING') {
        const friendlyMessage =
          'This payment is already being processed. Check its payment status before starting another checkout.';

        const enhancedError = new Error(friendlyMessage);

        enhancedError.response = {
          ...error?.response,
          data: {
            ...error?.response?.data,
            error: friendlyMessage,
          },
        };
        enhancedError.status = error?.response?.status;
        enhancedError.payment = existingPayment;

        throw enhancedError;
      }

      /*
       * PAID means there is nothing else to pay.
       */
      if (status === 'PAID') {
        const friendlyMessage = 'This payment has already been completed.';

        const enhancedError = new Error(friendlyMessage);

        enhancedError.response = {
          ...error?.response,
          data: {
            ...error?.response?.data,
            error: friendlyMessage,
          },
        };
        enhancedError.status = error?.response?.status;
        enhancedError.payment = existingPayment;

        throw enhancedError;
      }
    }

    const message =
      error?.response?.data?.error ||
      error?.response?.data?.message ||
      error?.message ||
      'Could not create payment';

    const enhancedError = new Error(message);

    enhancedError.response = error?.response;
    enhancedError.status = error?.response?.status;

    throw enhancedError;
  }
}
