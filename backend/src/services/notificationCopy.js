'use strict';

// SMS notification title translations, keyed by the same event types as
// notificationService.js's EVENT_COPY.
//
// IMPORTANT — translation quality: these were drafted without a native
// Amharic or Afaan Oromo speaker's review. They're a reasonable-effort
// starting point, intentionally kept to short, simple phrases to minimize
// the chance of a real error, but this is a live product handling real
// money — have someone fluent check these (especially the payment/refund
// ones) before turning on SMS for users whose preferredLanguage isn't
// "en". Afaan Oromo coverage below is deliberately partial for the same
// reason: entries left out fall back to the English title rather than
// risk a wrong translation.
//
// English is always complete (it's the source) and always the fallback.

const TITLES = {
  en: {
    PICKUP_WINDOW_REMINDER: 'Pickup window approaching',
    ORDER_CREATED: 'New order created',
    INSPECTION_ACCEPTED: 'Inspection accepted',
    INSPECTION_STARTED: 'Inspection started',
    INSPECTION_COMPLETED: 'Inspection completed',
    BUYER_DECISION_MADE: 'Buyer decision recorded',
    PAYMENT_STATUS_CHANGED: 'Payment status updated',
    TRANSPORT_STATUS_CHANGED: 'Transport status updated',
    RECEIPT_CONFIRMED: 'Receipt confirmed',
    ORDER_CANCELLED: 'Order cancelled',
    PAYMENT_REFUND_REQUESTED: 'Refund requested',
    PAYMENT_REFUNDED: 'Payment refunded',
    PAYMENT_REFUND_FAILED: 'Refund could not be completed',
    PAYMENT_RECONCILIATION_REQUIRED: 'Payment requires review',
    PAYMENT_RECONCILIATION_RESOLVED: 'Payment reconciliation resolved',
  },

  // Amharic — draft, needs native-speaker review (see header).
  am: {
    PICKUP_WINDOW_REMINDER: 'የመረከቢያ ጊዜ እየተቃረበ ነው',
    ORDER_CREATED: 'አዲስ ትዕዛዝ ተፈጥሯል',
    INSPECTION_ACCEPTED: 'ምርመራ ተቀባይነት አግኝቷል',
    INSPECTION_STARTED: 'ምርመራ ተጀምሯል',
    INSPECTION_COMPLETED: 'ምርመራ ተጠናቅቋል',
    BUYER_DECISION_MADE: 'የገዢ ውሳኔ ተመዝግቧል',
    PAYMENT_STATUS_CHANGED: 'የክፍያ ሁኔታ ተቀይሯል',
    TRANSPORT_STATUS_CHANGED: 'የመጓጓዣ ሁኔታ ተቀይሯል',
    RECEIPT_CONFIRMED: 'ደረሰኝ ተረጋግጧል',
    ORDER_CANCELLED: 'ትዕዛዝ ተሰርዟል',
    PAYMENT_REFUND_REQUESTED: 'ተመላሽ ገንዘብ ተጠይቋል',
    PAYMENT_REFUNDED: 'ገንዘብ ተመላሽ ተደርጓል',
    PAYMENT_REFUND_FAILED: 'ተመላሽ ገንዘብ አልተሳካም',
    PAYMENT_RECONCILIATION_REQUIRED: 'ክፍያ ግምገማ ይፈልጋል',
    PAYMENT_RECONCILIATION_RESOLVED: 'የክፍያ ግምገማ ተፈትቷል',
  },

  // Afaan Oromo — partial by design (see header). Missing keys fall back
  // to English rather than guess.
  om: {
    ORDER_CREATED: 'Ajajni haaraa uumameera',
    ORDER_CANCELLED: 'Ajajni haqameera',
    RECEIPT_CONFIRMED: 'Simannaan mirkanaa\'eera',
  },
};

function localizedTitle(eventType, language) {
  const lang = TITLES[language] ? language : 'en';
  return TITLES[lang][eventType] || TITLES.en[eventType] || 'Order update';
}

module.exports = { localizedTitle, SUPPORTED_SMS_LANGUAGES: Object.keys(TITLES) };
