import api from '../api/client';

// Starts Chapa's hosted checkout for an existing payment id and redirects
// the browser there. Throws on failure so callers can show their own
// error message.
export async function chapaInitializeAndRedirect(paymentId) {
  if (!paymentId) throw new Error('Payment was not created');

  const { data: initData } = await api.post(`/payments/${paymentId}/chapa/initialize`);
  if (!initData?.checkoutUrl) throw new Error('Could not start Chapa checkout');

  window.location.href = initData.checkoutUrl;
}

// Creates a payment intent, then starts Chapa's hosted checkout and
// redirects the browser there. Use this when there's no dedicated
// creation endpoint (marketplace, transport, inspection, advertising
// payments all go through the generic POST /payments route). For digital
// purchases, the payment is created as part of the purchase endpoint
// instead — use chapaInitializeAndRedirect directly with that payment's id.
export async function startChapaPayment(paymentPayload) {
  const { data } = await api.post('/payments', paymentPayload);
  await chapaInitializeAndRedirect(data?.payment?.id);
}
