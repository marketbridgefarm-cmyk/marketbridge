const express = require('express');
const crypto = require('crypto');
const {
body,
param,
validationResult,
} = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const {
isAdmin,
isOrderParticipant,
} = require('../utils/authorization');
const { commissionFor } = require('../config/commissions');

const router = express.Router();

/*
|--------------------------------------------------------------------------

Chapa configuration

|
| TEST:
|   CHAPA_MODE=test
|   CHAPA_TEST_SECRET_KEY=CHASECK_TEST-xxxxxxxx
|
| LIVE:
|   CHAPA_MODE=live
|   CHAPA_LIVE_SECRET_KEY=CHASECK-xxxxxxxx
|
| The code automatically selects the correct key.

const CHAPA_BASE_URL =
process.env.CHAPA_BASE_URL || 'https://api.chapa.co';

function getChapaSecretKey() {
const mode = String(process.env.CHAPA_MODE || 'test')
.trim()
.toLowerCase();

if (mode === 'live') {
return process.env.CHAPA_LIVE_SECRET_KEY || '';
}

return process.env.CHAPA_TEST_SECRET_KEY || '';
}

function getChapaMode() {
const mode = String(process.env.CHAPA_MODE || 'test')
.trim()
.toLowerCase();

return mode === 'live' ? 'live' : 'test';
}

/*
|--------------------------------------------------------------------------

Generic helpers
*/

const validate = (req, res, next) => {
const errors = validationResult(req);

if (!errors.isEmpty()) {
return res.status(400).json({
error: 'Validation failed',
errors: errors.array(),
});
}

next();
};

function timingSafeEqual(a, b) {
const x = Buffer.from(a || '', 'utf8');
const y = Buffer.from(b || '', 'utf8');

return (
x.length === y.length &&
crypto.timingSafeEqual(x, y)
);
}

function verifySignature(req) {
const secret = process.env.PAYMENT_WEBHOOK_SECRET;

if (!secret) {
return false;
}

const raw =
req.rawBody ||
Buffer.from(JSON.stringify(req.body));

const expected = crypto
.createHmac('sha256', secret)
.update(raw)
.digest('hex');

const supplied =
req.headers['x-marketbridge-signature'];

return (
typeof supplied === 'string' &&
timingSafeEqual(supplied, expected)
);
}

function normalizeEthiopianPhone(phone) {
if (!phone) return '';

let value = String(phone)
.trim()
.replace(/[\s()-]/g, '');

if (value.startsWith('+251')) {
value = "0${value.slice(4)}";
} else if (value.startsWith('251')) {
value = "0${value.slice(3)}";
}

return value;
}

function isValidEthiopianPhone(phone) {
return /^09\d{8}$/.test(phone);
}

function generateTxRef(paymentId) {
return "MB-${paymentId}-${Date.now()}";
}

/*
|--------------------------------------------------------------------------

Chapa HTTP helper
*/

async function chapaRequest(path, options = {}) {
const secretKey = getChapaSecretKey();

if (!secretKey) {
const error = new Error(
'Chapa secret key is not configured'
);

error.status = 503;
throw error;

}

const url = "${CHAPA_BASE_URL}${path}";

const headers = {
Authorization: "Bearer ${secretKey}",
...(options.headers || {}),
};

const response = await fetch(url, {
...options,
headers,
});

const text = await response.text();

let data;

try {
data = text ? JSON.parse(text) : {};
} catch {
data = {
raw: text,
};
}

if (!response.ok) {
const error = new Error(
data?.message ||
data?.error ||
"Chapa request failed with status ${response.status}"
);

error.status = response.status;
error.chapaResponse = data;

throw error;

}

return data;
}

/*
|--------------------------------------------------------------------------

Chapa Direct Charge

|
| Chapa currently documents:
|
|   POST /v1/charges?type=telebirr
|   POST /v1/charges?type=cbebirr
|
| The direct charge request requires:
|
|   amount
|   currency
|   tx_ref
|   mobile
|
| Chapa may return an authorization/reference response depending
| on the payment method and transaction state.

async function initiateChapaDirectCharge({
payment,
user,
method,
}) {
const chapaType =
method === 'TELEBIRR'
? 'telebirr'
: method === 'CBE'
? 'cbebirr'
: null;

if (!chapaType) {
const error = new Error(
'Unsupported Chapa direct-charge payment method'
);

error.status = 400;
throw error;

}

const mobile = normalizeEthiopianPhone(user.phone);

if (!mobile || !isValidEthiopianPhone(mobile)) {
const error = new Error(
'A valid Ethiopian mobile number is required for Chapa Telebirr/CBE payment'
);

error.status = 400;
throw error;

}

const txRef = generateTxRef(payment.id);

/*

* Chapa's Direct Charge endpoint expects multipart/form-data.
* Node 20 provides FormData and fetch natively.
  */
  const form = new FormData();

form.append(
'amount',
Number(payment.amount).toFixed(2)
);

form.append('currency', 'ETB');
form.append('tx_ref', txRef);
form.append('mobile', mobile);

const chapaResponse = await chapaRequest(
"/v1/charges?type=${encodeURIComponent(chapaType)}",
{
method: 'POST',
body: form,
}
);

/*

* Store the transaction reference immediately.
* 
* The actual payment must NOT be marked PAID here.
* It becomes PAID only after Chapa verification/webhook.
  */
  const chapaReference =
  chapaResponse?.data?.reference ||
  chapaResponse?.reference ||
  null;

const updatedPayment =
await prisma.payment.update({
where: {
id: payment.id,
},
data: {
reference: txRef,
provider: 'CHAPA',
providerTransactionId:
chapaReference,
},
});

return {
payment: updatedPayment,
txRef,
chapaReference,
method: chapaType,
mode: getChapaMode(),
response: chapaResponse,
};
}

/*
|--------------------------------------------------------------------------

Chapa transaction verification
*/

async function verifyChapaTransaction(txRef) {
return chapaRequest(
"/v1/transaction/verify/${encodeURIComponent(txRef)}",
{
method: 'GET',
}
);
}

/*
|--------------------------------------------------------------------------

Apply a verified payment
*/

async function applyPaidPayment(
tx,
payment,
chapaData = {}
) {
if (!payment) {
throw Object.assign(
new Error('Payment not found'),
{ status: 404 }
);
}

if (payment.status === 'REFUNDED') {
throw Object.assign(
new Error(
'A refunded payment cannot be reopened'
),
{ status: 409 }
);
}

if (payment.status === 'PAID') {
return payment;
}

const commission = commissionFor(
payment.type,
payment.amount
);

const reference =
chapaData.reference ||
chapaData.tx_ref ||
payment.reference;

const providerTransactionId =
chapaData.chapa_reference ||
chapaData.reference ||
chapaData.providerTransactionId ||
payment.providerTransactionId;

const updated =
await tx.payment.update({
where: {
id: payment.id,
},
data: {
status: 'PAID',
reference,
provider: chapaData.provider || payment.provider,
providerTransactionId,
commissionRate: commission.rate,
commissionAmount:
commission.commissionAmount,
},
});

if (
payment.type === 'MARKETPLACE' &&
payment.orderId
) {
await tx.order.updateMany({
where: {
id: payment.orderId,
status: 'PENDING_PAYMENT',
},
data: {
status: 'CONFIRMED',
},
});
}

if (
payment.type === 'DIGITAL' &&
payment.digitalPurchase
) {
await tx.digitalPurchase.update({
where: {
id: payment.digitalPurchase.id,
},
data: {
status: 'COMPLETED',
},
});
}

if (
payment.type === 'ADVERTISING' &&
payment.advertisementId
) {
await tx.advertisement.update({
where: {
id: payment.advertisementId,
},
data: {
amountPaid: payment.amount,
},
});
}

return updated;
}

/*
|--------------------------------------------------------------------------

CREATE PAYMENT

|
| Existing manual payment creation is preserved.
|
| For:
|   TELEBIRR
|   CBE
|
| the endpoint now creates the Payment record and immediately
| starts the Chapa Direct Charge.
|
| QR remains a pending/manual payment method for now.

router.post(
'/',
authenticate,
[
body('type').isIn([
'MARKETPLACE',
'TRANSPORT',
'INSPECTOR',
'ADVERTISING',
'DIGITAL',
]),

body('amount').isFloat({
  gt: 0,
}),

body('method').isIn([
  'TELEBIRR',
  'CBE',
  'QR',
  'OTHER',
]),

body('orderId')
  .optional()
  .isUUID(),

body('digitalProductId')
  .optional()
  .isUUID(),

body('advertisementId')
  .optional()
  .isUUID(),

body('inspectionRequestId')
  .optional()
  .isUUID(),

body('reference')
  .optional()
  .isString()
  .trim()
  .isLength({
    max: 200,
  }),

body('phone')
  .optional()
  .isString()
  .trim()
  .isLength({
    min: 9,
    max: 20,
  }),

],
validate,
async (req, res) => {
try {
const {
type,
orderId,
digitalProductId,
advertisementId,
inspectionRequestId,
reference,
} = req.body;

  const amount = Number(
    req.body.amount
  );

  const method = req.body.method;

  /*
   * ---------------------------------------------------------------
   * Load user
   * ---------------------------------------------------------------
   */

  const user =
    await prisma.user.findUnique({
      where: {
        id: req.user.id,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
      },
    });

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  /*
   * Allow the frontend to provide a phone number.
   *
   * We do not permanently overwrite the user's phone here.
   * The number is only used for this payment attempt.
   */
  const paymentPhone =
    req.body.phone ||
    user.phone ||
    '';

  /*
   * ---------------------------------------------------------------
   * MARKETPLACE / TRANSPORT
   * ---------------------------------------------------------------
   */

  let order = null;

  if (
    type === 'MARKETPLACE' ||
    type === 'TRANSPORT'
  ) {
    if (!orderId) {
      return res.status(400).json({
        error:
          `${type} payment requires orderId`,
      });
    }

    order =
      await prisma.order.findUnique({
        where: {
          id: orderId,
        },
        include: {
          transportJob: true,
        },
      });

    if (!order) {
      return res.status(404).json({
        error: 'Order not found',
      });
    }

    if (
      !isOrderParticipant(
        req.user.id,
        order
      ) &&
      !isAdmin(req.user)
    ) {
      return res.status(403).json({
        error: 'Not authorized',
      });
    }

    /*
     * MARKETPLACE payment
     */

    if (type === 'MARKETPLACE') {
      if (
        order.buyerId !== req.user.id &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Only the buyer may create the marketplace payment',
        });
      }

      if (
        Math.abs(
          amount -
            Number(order.finalPrice)
        ) > 0.01
      ) {
        return res.status(400).json({
          error:
            'Amount must match order final price',
          expectedAmount:
            Number(order.finalPrice),
        });
      }

      if (
        order.status !== 'PENDING_PAYMENT'
      ) {
        return res.status(409).json({
          error:
            `Order cannot be paid while it is ${order.status}`,
        });
      }
    }

    /*
     * TRANSPORT payment
     */

    if (type === 'TRANSPORT') {
      if (!order.transportJob) {
        return res.status(400).json({
          error: 'Transport job required',
        });
      }

      if (
        order.transportJob.method ===
        'OWN_TRUCK'
      ) {
        return res.status(400).json({
          error:
            'Own-truck arrangements are settled directly between the parties; no platform payment applies',
        });
      }

      if (
        order.transportJob.agreedAmount ==
        null
      ) {
        return res.status(400).json({
          error:
            'This transport job has no accepted quote yet',
        });
      }

      if (
        Math.abs(
          amount -
            Number(
              order.transportJob
                .agreedAmount
            )
        ) > 0.01
      ) {
        return res.status(400).json({
          error:
            'Amount must match the accepted transport quote',
          expectedAmount:
            Number(
              order.transportJob
                .agreedAmount
            ),
        });
      }

      const allowed =
        order.arrangingParty ===
          'BUYER'
          ? order.buyerId ===
            req.user.id
          : order.arrangingParty ===
              'SELLER'
            ? order.sellerId ===
              req.user.id
            : order.buyerId ===
                req.user.id ||
              order.sellerId ===
                req.user.id;

      if (
        !allowed &&
        !isAdmin(req.user)
      ) {
        return res.status(403).json({
          error:
            'Not authorized to pay for this transport',
        });
      }
    }
  }

  /*
   * ---------------------------------------------------------------
   * DIGITAL
   * ---------------------------------------------------------------
   */

  else if (type === 'DIGITAL') {
    if (!digitalProductId) {
      return res.status(400).json({
        error:
          'digitalProductId is required',
      });
    }

    const product =
      await prisma.digitalProduct.findUnique(
        {
          where: {
            id: digitalProductId,
          },
        }
      );

    if (
      !product ||
      product.status !== 'ACTIVE'
    ) {
      return res.status(404).json({
        error:
          'Digital product not found',
      });
    }

    if (
      product.sellerId ===
      req.user.id
    ) {
      return res.status(400).json({
        error:
          'You cannot purchase your own product',
      });
    }

    if (
      Math.abs(
        amount -
          Number(product.price)
      ) > 0.01
    ) {
      return res.status(400).json({
        error:
          'Amount must match product price',
        expectedAmount:
          Number(product.price),
      });
    }
  }

  /*
   * ---------------------------------------------------------------
   * ADVERTISING
   * ---------------------------------------------------------------
   */

  else if (type === 'ADVERTISING') {
    if (!advertisementId) {
      return res.status(400).json({
        error:
          'advertisementId is required',
      });
    }

    const ad =
      await prisma.advertisement.findUnique(
        {
          where: {
            id: advertisementId,
          },
        }
      );

    if (!ad) {
      return res.status(404).json({
        error:
          'Advertisement not found',
      });
    }

    if (
      ad.advertiserId !==
        req.user.id &&
      !isAdmin(req.user)
    ) {
      return res.status(403).json({
        error:
          'Not authorized',
      });
    }

    if (
      ad.amountPaid != null &&
      Math.abs(
        amount -
          Number(ad.amountPaid)
      ) > 0.01
    ) {
      return res.status(400).json({
        error:
          'Amount must match advertisement amount',
        expectedAmount:
          Number(ad.amountPaid),
      });
    }
  }

  /*
   * ---------------------------------------------------------------
   * INSPECTOR
   * ---------------------------------------------------------------
   */

  else if (type === 'INSPECTOR') {
    if (!inspectionRequestId) {
      return res.status(400).json({
        error:
          'inspectionRequestId is required',
      });
    }

    const request =
      await prisma.inspectionRequest.findUnique(
        {
          where: {
            id: inspectionRequestId,
          },
        }
      );

    if (!request) {
      return res.status(404).json({
        error:
          'Inspection request not found',
      });
    }

    if (
      request.requestedById !==
        req.user.id &&
      !isAdmin(req.user)
    ) {
      return res.status(403).json({
        error:
          'Only the person who requested the inspection may pay for it',
      });
    }

    if (request.fee == null) {
      return res.status(400).json({
        error:
          'This inspection has no agreed fee yet',
      });
    }

    if (
      Math.abs(
        amount -
          Number(request.fee)
      ) > 0.01
    ) {
      return res.status(400).json({
        error:
          'Amount must match the agreed inspection fee',
        expectedAmount:
          Number(request.fee),
      });
    }
  }

  /*
   * ---------------------------------------------------------------
   * Reject unrelated IDs
   * ---------------------------------------------------------------
   */

  else if (
    orderId ||
    digitalProductId ||
    advertisementId ||
    inspectionRequestId
  ) {
    return res.status(400).json({
      error:
        'This payment type cannot use the supplied resource id',
    });
  }

  /*
   * ---------------------------------------------------------------
   * Duplicate prevention
   * ---------------------------------------------------------------
   */

  const duplicate =
    await prisma.payment.findFirst({
      where: {
        createdById: req.user.id,
        type,
        status: {
          in: [
            'PENDING',
            'PAID',
          ],
        },

        ...(orderId && {
          orderId,
        }),

        ...(digitalProductId && {
          digitalProductId,
        }),

        ...(advertisementId && {
          advertisementId,
        }),

        ...(inspectionRequestId && {
          inspectionRequestId,
        }),
      },
    });

  if (duplicate) {
    return res.status(409).json({
      error:
        'An active payment already exists',
      payment: duplicate,
    });
  }

  /*
   * ---------------------------------------------------------------
   * Create local Payment record
   * ---------------------------------------------------------------
   */

  const payment =
    await prisma.payment.create({
      data: {
        createdById:
          req.user.id,

        type,

        amount,

        method,

        reference:
          reference || null,

        orderId:
          orderId || null,

        digitalProductId:
          digitalProductId || null,

        advertisementId:
          advertisementId || null,

        inspectionRequestId:
          inspectionRequestId || null,

        provider:
          method === 'TELEBIRR' ||
          method === 'CBE'
            ? 'CHAPA'
            : null,

        status: 'PENDING',
      },
    });

  /*
   * ---------------------------------------------------------------
   * CHAPA TELEBIRR / CBE DIRECT CHARGE
   * ---------------------------------------------------------------
   */

  if (
    method === 'TELEBIRR' ||
    method === 'CBE'
  ) {
    /*
     * Direct charge requires the mobile number.
     *
     * Temporarily use the submitted phone if supplied.
     */
    const directChargeUser = {
      ...user,
      phone: paymentPhone,
    };

    try {
      const chapa =
        await initiateChapaDirectCharge({
          payment,
          user: directChargeUser,
          method,
        });

      return res.status(201).json({
        message:
          'Chapa payment initiated. Authorize the payment on your phone.',
        payment:
          chapa.payment,
        paymentConfirmed:
          false,
        chapa: {
          provider:
            'CHAPA',
          method:
            chapa.method,
          mode:
            chapa.mode,
          txRef:
            chapa.txRef,
          chapaReference:
            chapa.chapaReference,
          response:
            chapa.response,
        },
      });
    } catch (error) {
      /*
       * Do not leave a misleading payment intent
       * active when Chapa rejected the initiation.
       */
      try {
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'FAILED',
          },
        });
      } catch {
        // Preserve original Chapa error.
      }

      return res.status(
        error.status || 502
      ).json({
        error:
          error.message ||
          'Unable to initiate Chapa payment',
        provider:
          'CHAPA',
        mode:
          getChapaMode(),
        details:
          error.chapaResponse ||
          undefined,
      });
    }
  }

  /*
   * ---------------------------------------------------------------
   * QR / OTHER
   * ---------------------------------------------------------------
   *
   * These remain pending/manual payment methods in this backend.
   * They can be upgraded to Chapa hosted checkout separately.
   */

  return res.status(201).json({
    message:
      'Payment intent created; it is not paid until verified by a gateway webhook or admin reconciliation.',
    payment,
    paymentConfirmed: false,
  });
} catch (error) {
  console.error(
    'Payment creation error:',
    error
  );

  return res.status(
    error.status || 500
  ).json({
    error:
      error.message ||
      'Payment creation failed',
  });
}

}
);

/*
|--------------------------------------------------------------------------

Chapa verification endpoint

|
| The frontend may call this after the customer completes/authorizes
| a direct-charge transaction.
|
| IMPORTANT:
| We verify with Chapa's server API before marking the payment PAID.

router.post(
'/chapa/verify',
authenticate,
[
body('paymentId')
.isUUID(),

body('txRef')
  .isString()
  .trim()
  .isLength({
    min: 3,
    max: 200,
  }),

],
validate,
async (req, res) => {
try {
const {
paymentId,
txRef,
} = req.body;

  const payment =
    await prisma.payment.findUnique({
      where: {
        id: paymentId,
      },
      include: {
        order: true,
        digitalPurchase: true,
        advertisement: true,
      },
    });

  if (!payment) {
    return res.status(404).json({
      error:
        'Payment not found',
    });
  }

  const authorized =
    payment.createdById ===
      req.user.id ||
    (payment.order &&
      isOrderParticipant(
        req.user.id,
        payment.order
      )) ||
    isAdmin(req.user);

  if (!authorized) {
    return res.status(403).json({
      error:
        'Not authorized',
    });
  }

  if (
    payment.status === 'PAID'
  ) {
    return res.json({
      payment,
      paymentConfirmed: true,
      message:
        'Payment is already confirmed',
    });
  }

  if (
    payment.status ===
    'REFUNDED'
  ) {
    return res.status(409).json({
      error:
        'Payment has already been refunded',
    });
  }

  if (
    payment.provider !==
    'CHAPA'
  ) {
    return res.status(400).json({
      error:
        'This payment was not created through Chapa',
    });
  }

  /*
   * Prevent verifying an unrelated reference.
   */
  if (
    payment.reference &&
    payment.reference !==
      txRef
  ) {
    return res.status(400).json({
      error:
        'Transaction reference does not match the payment',
    });
  }

  const result =
    await verifyChapaTransaction(
      txRef
    );

  /*
   * Chapa's response structure can vary.
   * We inspect the common status fields.
   */
  const status = String(
    result?.data?.status ||
      result?.status ||
      ''
  ).toLowerCase();

  const chapaData =
    result?.data ||
    result;

  if (
    status !== 'success' &&
    status !== 'paid'
  ) {
    if (
      [
        'failed',
        'cancelled',
        'reversed',
      ].includes(status)
    ) {
      const failed =
        await prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status:
              'FAILED',
            provider:
              'CHAPA',
            providerTransactionId:
              chapaData?.reference ||
              payment.providerTransactionId,
          },
        });

      return res.json({
        payment: failed,
        paymentConfirmed:
          false,
        chapa: result,
      });
    }

    return res.json({
      payment,
      paymentConfirmed:
        false,
      message:
        'Chapa has not confirmed this transaction as successful yet.',
      chapa: result,
    });
  }

  /*
   * Verify amount where Chapa provides it.
   */
  const chapaAmount = Number(
    chapaData?.amount
  );

  if (
    Number.isFinite(
      chapaAmount
    ) &&
    Math.abs(
      chapaAmount -
        Number(payment.amount)
    ) > 0.01
  ) {
    return res.status(409).json({
      error:
        'Verified Chapa amount does not match the MarketBridge payment amount',
      expectedAmount:
        Number(payment.amount),
      chapaAmount,
    });
  }

  const updated =
    await prisma.$transaction(
      async (tx) => {
        return applyPaidPayment(
          tx,
          payment,
          {
            provider:
              'CHAPA',

            reference:
              chapaData?.tx_ref ||
              txRef,

            chapa_reference:
              chapaData?.reference,
          }
        );
      }
    );

  return res.json({
    message:
      'Chapa payment verified successfully',
    payment:
      updated,
    paymentConfirmed:
      true,
    chapa:
      result,
  });
} catch (error) {
  console.error(
    'Chapa verification error:',
    error
  );

  return res.status(
    error.status || 502
  ).json({
    error:
      error.message ||
      'Unable to verify Chapa payment',
    details:
      error.chapaResponse ||
      undefined,
  });
}

}
);

/*
|--------------------------------------------------------------------------

Chapa webhook

|
| Chapa webhook payloads use events such as:
|
|   charge.success
|   charge.failed/cancelled
|   charge.refunded
|   charge.reversed
|
| We identify the MarketBridge payment using tx_ref.

router.post(
'/webhooks/chapa',
express.json({
limit: '100kb',
}),
async (req, res) => {
try {
/*
* If PAYMENT_WEBHOOK_SECRET is configured,
* require the MarketBridge signature.
*
* This protects the generic internal webhook.
*
* Chapa's own webhook verification can also be
* configured according to the Chapa dashboard.
*/
if (
process.env.PAYMENT_WEBHOOK_SECRET
) {
if (
!verifySignature(req)
) {
return res.status(401).json({
error:
'Invalid webhook signature',
});
}
}

  const body = req.body || {};

  const event = String(
    body.event || ''
  ).toLowerCase();

  const txRef =
    body.tx_ref ||
    body.data?.tx_ref ||
    body.reference ||
    body.data?.reference;

  if (!txRef) {
    return res.status(400).json({
      error:
        'Chapa webhook does not contain a transaction reference',
    });
  }

  const payment =
    await prisma.payment.findFirst({
      where: {
        OR: [
          {
            reference: txRef,
          },
          {
            providerTransactionId:
              txRef,
          },
        ],
      },
      include: {
        order: true,
        digitalPurchase: true,
        advertisement: true,
      },
    });

  if (!payment) {
    /*
     * Return 200 so Chapa does not repeatedly retry
     * an event for a transaction MarketBridge does not know.
     */
    return res.json({
      ok: true,
      ignored: true,
      message:
        'Payment not found in MarketBridge',
    });
  }

  /*
   * ---------------------------------------------------------------
   * SUCCESS
   * ---------------------------------------------------------------
   */

  if (
    event === 'charge.success' ||
    String(
      body.status ||
        body.data?.status ||
        ''
    ).toLowerCase() ===
      'success'
  ) {
    const updated =
      await prisma.$transaction(
        async (tx) => {
          return applyPaidPayment(
            tx,
            payment,
            {
              provider:
                'CHAPA',

              reference:
                body.tx_ref ||
                txRef,

              chapa_reference:
                body.reference ||
                body.data?.reference,

              providerTransactionId:
                body.reference ||
                body.data?.reference,
            }
          );
        }
      );

    return res.json({
      ok: true,
      payment:
        updated,
    });
  }

  /*
   * ---------------------------------------------------------------
   * REFUNDED
   * ---------------------------------------------------------------
   */

  if (
    event ===
      'charge.refunded' ||
    String(
      body.status ||
        body.data?.status ||
        ''
    ).toLowerCase() ===
      'refunded'
  ) {
    const updated =
      await prisma.$transaction(
        async (tx) => {
          const p =
            await tx.payment.update({
              where: {
                id: payment.id,
              },
              data: {
                status:
                  'REFUNDED',

                provider:
                  'CHAPA',

                providerTransactionId:
                  body.reference ||
                  body.data?.reference ||
                  payment.providerTransactionId,
              },
            });

          if (
            payment.digitalPurchase
          ) {
            await tx.digitalPurchase.update(
              {
                where: {
                  id:
                    payment
                      .digitalPurchase
                      .id,
                },
                data: {
                  status:
                    'REFUNDED',
                },
              }
            );
          }

          return p;
        }
      );

    return res.json({
      ok: true,
      payment:
        updated,
    });
  }

  /*
   * ---------------------------------------------------------------
   * FAILED / CANCELLED / REVERSED
   * ---------------------------------------------------------------
   */

  if (
    event ===
      'charge.failed/cancelled' ||
    event ===
      'charge.failed' ||
    event ===
      'charge.reversed' ||
    [
      'failed',
      'cancelled',
      'reversed',
    ].includes(
      String(
        body.status ||
          body.data?.status ||
          ''
      ).toLowerCase()
    )
  ) {
    const updated =
      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          status:
            'FAILED',

          provider:
            'CHAPA',

          providerTransactionId:
            body.reference ||
            body.data?.reference ||
            payment.providerTransactionId,
        },
      });

    return res.json({
      ok: true,
      payment:
        updated,
    });
  }

  /*
   * Unknown Chapa event.
   */
  return res.json({
    ok: true,
    ignored: true,
    event,
  });
} catch (error) {
  console.error(
    'Chapa webhook error:',
    error
  );

  return res.status(500).json({
    error:
      'Chapa webhook processing failed',
  });
}

}
);

/*
|--------------------------------------------------------------------------

Generic signed gateway webhook

|
| Kept for existing MarketBridge integrations/manual gateway adapters.

router.post(
'/webhooks/generic',
express.json({
limit: '100kb',
}),
async (req, res) => {
if (!verifySignature(req)) {
return res.status(401).json({
error:
'Invalid webhook signature',
});
}

const {
  paymentId,
  status,
  reference,
  provider,
  providerTransactionId,
} = req.body;

if (
  !paymentId ||
  ![
    'PAID',
    'FAILED',
    'REFUNDED',
  ].includes(status)
) {
  return res.status(400).json({
    error:
      'Invalid webhook payload',
  });
}

try {
  const result =
    await prisma.$transaction(
      async (tx) => {
        const payment =
          await tx.payment.findUnique(
            {
              where: {
                id: paymentId,
              },
              include: {
                order: true,
                digitalPurchase: true,
                advertisement: true,
              },
            }
          );

        if (!payment) {
          throw Object.assign(
            new Error(
              'Payment not found'
            ),
            {
              status: 404,
            }
          );
        }

        if (
          payment.status ===
            'PAID' &&
          status === 'PAID'
        ) {
          return payment;
        }

        if (
          payment.status ===
            'REFUNDED' &&
          status !== 'REFUNDED'
        ) {
          throw Object.assign(
            new Error(
              'Refunded payment cannot be reopened'
            ),
            {
              status: 409,
            }
          );
        }

        if (status === 'PAID') {
          return applyPaidPayment(
            tx,
            payment,
            {
              provider,
              reference,
              providerTransactionId,
            }
          );
        }

        const updated =
          await tx.payment.update({
            where: {
              id: payment.id,
            },
            data: {
              status,
              reference:
                reference ||
                payment.reference,
              provider:
                provider ||
                payment.provider,
              providerTransactionId:
                providerTransactionId ||
                payment.providerTransactionId,
            },
          });

        if (
          status ===
            'REFUNDED' &&
          payment.digitalPurchase
        ) {
          await tx.digitalPurchase.update(
            {
              where: {
                id:
                  payment
                    .digitalPurchase
                    .id,
              },
              data: {
                status:
                  'REFUNDED',
              },
            }
          );
        }

        return updated;
      }
    );

  return res.json({
    ok: true,
    payment:
      result,
  });
} catch (e) {
  return res.status(
    e.status || 500
  ).json({
    error:
      e.status
        ? e.message
        : 'Webhook processing failed',
  });
}

}
);

/*
|--------------------------------------------------------------------------

Admin payment queue
*/

router.get(
'/',
authenticate,
async (req, res) => {
if (!isAdmin(req.user)) {
return res.status(403).json({
error:
'Only an administrator can view all payments',
});
}

const {
  status,
} = req.query;

const payments =
  await prisma.payment.findMany({
    where: {
      ...(status && {
        status,
      }),
    },

    include: {
      createdBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },

      order: {
        select: {
          id: true,
          finalPrice: true,
        },
      },

      digitalProduct: {
        select: {
          id: true,
          title: true,
        },
      },

      advertisement: {
        select: {
          id: true,
          type: true,
        },
      },

      inspectionRequest: {
        select: {
          id: true,
          fee: true,
        },
      },
    },

    orderBy: {
      createdAt: 'desc',
    },
  });

return res.json({
  payments,
  count:
    payments.length,
});

}
);

/*
|--------------------------------------------------------------------------

Commission summary
*/

router.get(
'/commissions/summary',
authenticate,
async (req, res) => {
if (!isAdmin(req.user)) {
return res.status(403).json({
error:
'Only an administrator can view commission records',
});
}

const paid =
  await prisma.payment.findMany({
    where: {
      status: 'PAID',
    },

    select: {
      type: true,
      amount: true,
      commissionAmount: true,
    },
  });

const byType = {};

let totalCommission = 0;
let totalVolume = 0;

for (const p of paid) {
  const t =
    byType[p.type] || {
      volume: 0,
      commission: 0,
      count: 0,
    };

  t.volume +=
    Number(p.amount);

  t.commission +=
    Number(
      p.commissionAmount || 0
    );

  t.count += 1;

  byType[p.type] = t;

  totalVolume +=
    Number(p.amount);

  totalCommission +=
    Number(
      p.commissionAmount || 0
    );
}

return res.json({
  totalVolume,
  totalCommission,
  byType,
});

}
);

/*
|--------------------------------------------------------------------------

Legacy manual confirmation

|
| Kept for controlled admin reconciliation.
| Production payments should use Chapa verification/webhooks.

router.patch(
'/:id/confirm',
authenticate,
async (req, res) => {
if (!isAdmin(req.user)) {
return res.status(403).json({
error:
'Only an administrator can perform manual payment reconciliation',
});
}

const payment =
  await prisma.payment.findUnique({
    where: {
      id: req.params.id,
    },
  });

if (!payment) {
  return res.status(404).json({
    error:
      'Payment not found',
  });
}

if (
  payment.status !==
  'PENDING'
) {
  return res.status(409).json({
    error:
      `Payment is already ${payment.status}`,
  });
}

const commission =
  commissionFor(
    payment.type,
    payment.amount
  );

const updated =
  await prisma.$transaction(
    async (tx) => {
      const p =
        await tx.payment.update({
          where: {
            id: payment.id,
          },

          data: {
            status:
              'PAID',

            commissionRate:
              commission.rate,

            commissionAmount:
              commission.commissionAmount,
          },
        });

      if (
        payment.type ===
          'MARKETPLACE' &&
        payment.orderId
      ) {
        await tx.order.updateMany(
          {
            where: {
              id:
                payment.orderId,
              status:
                'PENDING_PAYMENT',
            },

            data: {
              status:
                'CONFIRMED',
            },
          }
        );
      }

      if (
        payment.type ===
        'DIGITAL'
      ) {
        const purchase =
          await tx.digitalPurchase.findUnique(
            {
              where: {
                paymentId:
                  payment.id,
              },
            }
          );

        if (purchase) {
          await tx.digitalPurchase.update(
            {
              where: {
                id:
                  purchase.id,
              },

              data: {
                status:
                  'COMPLETED',
              },
            }
          );
        }
      }

      if (
        payment.type ===
          'ADVERTISING' &&
        payment.advertisementId
      ) {
        await tx.advertisement.update(
          {
            where: {
              id:
                payment.advertisementId,
            },

            data: {
              amountPaid:
                payment.amount,
            },
          }
        );
      }

      return p;
    }
  );

return res.json({
  message:
    'Payment manually reconciled. Prefer Chapa verification/webhooks in production.',
  payment:
    updated,
});

}
);

/*
|--------------------------------------------------------------------------

Payments belonging to an order
*/

router.get(
'/order/:orderId',
authenticate,
[
param('orderId')
.isUUID(),
],
validate,
async (req, res) => {
const order =
await prisma.order.findUnique({
where: {
id:
req.params.orderId,
},
});

if (!order) {
  return res.status(404).json({
    error:
      'Order not found',
  });
}

if (
  !isOrderParticipant(
    req.user.id,
    order
  ) &&
  !isAdmin(req.user)
) {
  return res.status(403).json({
    error:
      'Not authorized',
  });
}

const payments =
  await prisma.payment.findMany({
    where: {
      orderId:
        order.id,
    },

    orderBy: {
      createdAt:
        'desc',
    },
  });

return res.json({
  payments,
  count:
    payments.length,
});

}
);

/*
|--------------------------------------------------------------------------

Single payment
*/

router.get(
'/:id',
authenticate,
[
param('id')
.isUUID(),
],
validate,
async (req, res) => {
const payment =
await prisma.payment.findUnique({
where: {
id:
req.params.id,
},

    include: {
      order: true,
      digitalPurchase: true,
    },
  });

if (!payment) {
  return res.status(404).json({
    error:
      'Payment not found',
  });
}

const owner =
  payment.createdById ===
  req.user.id;

const orderParticipant =
  payment.order &&
  isOrderParticipant(
    req.user.id,
    payment.order
  );

if (
  !owner &&
  !orderParticipant &&
  !isAdmin(req.user)
) {
  return res.status(403).json({
    error:
      'Not authorized',
  });
}

return res.json({
  payment,
});

}
);

module.exports = router;
