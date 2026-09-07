const axios = require('axios');

const CHAPA_BASE_URL = 'https://api.chapa.co/v1';

const initializePayment = async (orderData) => {
  try {
    const payload = {
      amount: orderData.amount,
      currency: 'ETB',
      email: orderData.email,
      first_name: orderData.firstName || 'Customer',
      last_name: orderData.lastName || '',
      tx_ref: `tx_mb_${Date.now()}_${orderData.orderId}`,
      callback_url: process.env.PAYMENT_CALLBACK_URL,
      return_url: process.env.PAYMENT_RETURN_URL,
      customization: {
        title: 'Marketbridge Order',
        description: `Order #${orderData.orderId}`,
      },
    };

    const response = await axios.post(`${CHAPA_BASE_URL}/transaction/initialize`, payload, {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    return response.data;
  } catch (error) {
    console.error('Chapa init error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Payment initialization failed');
  }
};

const verifyPayment = async (tx_ref) => {
  try {
    const response = await axios.get(`${CHAPA_BASE_URL}/transaction/verify/${tx_ref}`, {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      },
    });
    return response.data;
  } catch (error) {
    console.error('Chapa verify error:', error.response?.data || error.message);
    throw new Error('Payment verification failed');
  }
};

module.exports = { initializePayment, verifyPayment };
