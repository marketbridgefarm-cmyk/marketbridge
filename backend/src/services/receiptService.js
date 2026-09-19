'use strict';

// Generates a printable, downloadable PDF receipt for a single completed
// order — covering the goods payment plus any inspection/transport fees
// tied to the same order — so a user has one document per order suitable
// for their own bookkeeping or for a government quarterly filing.
//
// Kept deliberately simple (sequential text, no table library): pdfkit's
// low-level API is stable across versions and easy to reason about without
// a live render to check against.

const PDFDocument = require('pdfkit');

function fmtMoney(amount, currency = 'ETB') {
  const n = Number(amount || 0);
  const formatted = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${currency}`;
}

function fmtDate(date) {
  if (!date) return '\u2014';
  return new Date(date).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtPercent(rate) {
  if (rate == null) return '\u2014';
  return `${Number(rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

// The three marketplaces the platform runs, as shown on the receipt header
// so it's clear at a glance which one a given transaction belongs to.
const MARKETPLACE_LABELS = {
  AGRICULTURAL: 'Farm Produce Marketplace',
  PRODUCT: 'Products Marketplace',
  DIGITAL: 'Digital Marketplace',
};

// The services (as opposed to marketplace-sale) that also involve a
// platform commission — used for the badge on an earnings statement,
// where the counterparty is being paid a fee rather than buying goods.
const SERVICE_LABELS = {
  TRANSPORT: 'Transport Service',
  INSPECTOR: 'Inspection Service',
};

function marketplaceLabel(category) {
  return MARKETPLACE_LABELS[category] || 'Marketplace';
}

// Every payment touching this order — the marketplace/goods payment itself
// plus any inspection or transport fees — deduplicated by id, since some
// of these relations can overlap.
function collectPayments(order) {
  const seen = new Set();
  const rows = [];

  const add = (payment, contextLabel) => {
    if (!payment || seen.has(payment.id)) return;
    seen.add(payment.id);
    // Refunds against this payment — completed ones plus any still in
    // flight — so a refunded (or partially refunded) item is visible on
    // the receipt rather than silently looking like a normal paid item.
    rows.push({ ...payment, contextLabel, refunds: payment.refunds || [] });
  };

  (order.payments || []).forEach((p) => add(p, 'Goods payment'));

  (order.inspectionRequests || []).forEach((request) => {
    (request.payments || []).forEach((p) => add(p, 'Inspection fee'));
  });

  if (order.transportJob) {
    (order.transportJob.payments || []).forEach((p) => add(p, 'Transport fee'));
  }

  return rows.sort(
    (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
  );
}

function drawHeader(doc, order) {
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#176b3a').text('MarketBridge');
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#555555')
    .text('Ethiopian Agricultural & Digital Marketplace');

  doc.moveDown(1);
  doc.fillColor('#000000').fontSize(15).font('Helvetica-Bold').text('Official Order Receipt');
  doc.moveDown(0.2);
  doc
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor('#176b3a')
    .text(marketplaceLabel(order.listing?.category));
  doc.moveDown(0.55);

  doc.fontSize(10).font('Helvetica').fillColor('#000000');
  doc.text(`Receipt generated: ${fmtDate(new Date())}`);
  doc.text(`Order ID: ${order.id}`);
  doc.text(`Order status: ${order.status}`);
  doc.text(`Order created: ${fmtDate(order.createdAt)}`);

  doc.moveDown(1);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.75);
}

function drawParties(doc, order) {
  doc.font('Helvetica-Bold').fontSize(11).text('Parties');
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10);

  doc.font('Helvetica-Bold').text('Buyer: ', { continued: true }).font('Helvetica').text(order.buyer?.name || '\u2014');
  if (order.buyer?.phone) doc.text(`  Phone: ${order.buyer.phone}`);
  if (order.buyer?.location) doc.text(`  Location: ${order.buyer.location}`);

  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').text('Seller: ', { continued: true }).font('Helvetica').text(order.seller?.name || '\u2014');
  if (order.seller?.phone) doc.text(`  Phone: ${order.seller.phone}`);
  if (order.seller?.location) doc.text(`  Location: ${order.seller.location}`);

  doc.moveDown(1);
}

function drawListing(doc, order) {
  const listing = order.listing || {};
  doc.font('Helvetica-Bold').fontSize(11).text('Goods / Listing');
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10);

  doc.text(`Item: ${listing.title || listing.cropType || '\u2014'}`);
  doc.text(`Quantity: ${order.quantity ?? '\u2014'} ${listing.unit || ''}`.trim());
  doc.text(`Agreed price: ${fmtMoney(order.finalPrice)}`);
  if (listing.location) doc.text(`Origin: ${listing.location}`);

  doc.moveDown(1);
}

function drawPaymentsTable(doc, payments, title = 'Payments on this order') {
  doc.font('Helvetica-Bold').fontSize(11).text(title);
  doc.moveDown(0.35);

  if (!payments.length) {
    doc.font('Helvetica').fontSize(10).text('No payments recorded on this order.');
    doc.moveDown(1);
    return;
  }

  const left = doc.page.margins.left;
  const colX = {
    item: left,
    amount: left + 220,
    commission: left + 320,
    net: left + 400,
    status: left + 470,
  };

  const rowHeight = 16;

  function drawRow({ item, amount, commission, net, status }, opts = {}) {
    const font = opts.bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(font).fontSize(9);
    const y = doc.y;
    doc.text(item, colX.item, y, { width: colX.amount - colX.item - 8 });
    doc.text(amount, colX.amount, y, { width: colX.commission - colX.amount - 8, align: 'right' });
    doc.text(commission, colX.commission, y, { width: colX.net - colX.commission - 8, align: 'right' });
    doc.text(net, colX.net, y, { width: colX.status - colX.net - 8, align: 'right' });
    doc.text(status, colX.status, y, { width: doc.page.width - doc.page.margins.right - colX.status });
    // Explicit fixed advance rather than doc.moveDown() — the column calls
    // above each nudge doc.y by their own wrapped-text height, so relying
    // on the cursor after all five would drift row spacing unpredictably.
    doc.y = y + rowHeight;
  }

  drawRow(
    { item: 'Item', amount: 'Amount', commission: 'Commission', net: 'Net', status: 'Status' },
    { bold: true }
  );
  doc
    .moveTo(left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.4);

  let totalPaid = 0;
  let totalCommission = 0;
  let totalRefunded = 0;
  const currency = payments[0]?.currency || 'ETB';

  payments.forEach((payment) => {
    const label = `${payment.contextLabel} (${payment.type})`;
    drawRow({
      item: label,
      amount: fmtMoney(payment.amount, payment.currency || currency),
      commission: payment.commissionAmount != null ? fmtMoney(payment.commissionAmount, payment.currency || currency) : '\u2014',
      net: payment.netAmount != null ? fmtMoney(payment.netAmount, payment.currency || currency) : '\u2014',
      status: payment.status,
    });

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#666666')
      .text(
        `  Method: ${payment.method}  \u00b7  Paid: ${fmtDate(payment.createdAt)}  \u00b7  Ref: ${payment.reference || payment.providerTransactionId || payment.id}`,
        colX.item,
        doc.y,
        { width: doc.page.width - doc.page.margins.right - colX.item }
      );
    doc.fillColor('#000000');

    // Any refund(s) against this payment — shown as its own indented
    // line(s) so goods that were paid for and then refunded are visible
    // on the receipt rather than looking like an ordinary completed sale.
    (payment.refunds || []).forEach((refund) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor('#a4372a')
        .text(
          `  \u21b3 Refund: -${fmtMoney(refund.amount, refund.currency || payment.currency || currency)}  \u00b7  Status: ${refund.status}  \u00b7  ${fmtDate(refund.completedAt || refund.createdAt)}${refund.reason ? `  \u00b7  Reason: ${refund.reason}` : ''}`,
          colX.item,
          doc.y,
          { width: doc.page.width - doc.page.margins.right - colX.item }
        );
      doc.fillColor('#000000');

      if (refund.status === 'COMPLETED') {
        totalRefunded += Number(refund.amount || 0);
      }
    });

    doc.moveDown(0.6);

    if (payment.status === 'PAID') {
      totalPaid += Number(payment.amount || 0);
      totalCommission += Number(payment.commissionAmount || 0);
    }
  });

  doc
    .moveTo(left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`Total paid: ${fmtMoney(totalPaid, currency)}`);
  doc.text(`Total platform commission: ${fmtMoney(totalCommission, currency)}`);
  if (totalRefunded > 0) {
    doc.fillColor('#a4372a').text(`Total refunded: -${fmtMoney(totalRefunded, currency)}`);
    doc.fillColor('#000000').text(`Net retained after refunds: ${fmtMoney(totalPaid - totalRefunded, currency)}`);
  }
  doc.moveDown(1);
}

function drawFooter(doc, referenceId, referenceLabel = 'Order reference') {
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.5);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666666')
    .text(
      'This receipt was generated automatically by MarketBridge from its transaction records and reflects the payment amounts, methods, refunds and platform commission recorded for this transaction. It is provided to help with recordkeeping and reporting, including quarterly filings and legal transit checks in transit; it is not a tax invoice and MarketBridge does not provide tax advice. Please verify formatting requirements with the receiving authority.',
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  doc.moveDown(0.5);
  doc.text(`${referenceLabel}: ${referenceId}`);
}

// Streams the PDF directly to an HTTP response. `res` must not have had
// headers sent yet; this function sets Content-Type/Content-Disposition.
function streamOrderReceiptPdf(order, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="marketbridge-order-${order.id}-receipt.pdf"`
  );

  doc.pipe(res);

  drawHeader(doc, order);
  drawParties(doc, order);
  drawListing(doc, order);
  drawPaymentsTable(doc, collectPayments(order));
  drawFooter(doc, order.id);

  doc.end();
}

// ============================================================================
// DIGITAL PURCHASE RECEIPT (PDF)
// ============================================================================
// The Digital marketplace doesn't use the Order model at all — a purchase
// there is its own DigitalPurchase + single Payment — so it gets its own,
// simpler receipt rather than being forced through the order-shaped one.
// ============================================================================

function drawDigitalHeader(doc, purchase) {
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#176b3a').text('MarketBridge');
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#555555')
    .text('Ethiopian Agricultural & Digital Marketplace');

  doc.moveDown(1);
  doc.fillColor('#000000').fontSize(15).font('Helvetica-Bold').text('Official Purchase Receipt');
  doc.moveDown(0.2);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#176b3a').text(marketplaceLabel('DIGITAL'));
  doc.moveDown(0.55);

  doc.fontSize(10).font('Helvetica').fillColor('#000000');
  doc.text(`Receipt generated: ${fmtDate(new Date())}`);
  doc.text(`Purchase ID: ${purchase.id}`);
  doc.text(`Purchase status: ${purchase.status}`);
  doc.text(`Purchase date: ${fmtDate(purchase.createdAt)}`);

  doc.moveDown(1);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.75);
}

function drawDigitalParties(doc, purchase) {
  doc.font('Helvetica-Bold').fontSize(11).text('Parties');
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10);

  doc.font('Helvetica-Bold').text('Buyer: ', { continued: true }).font('Helvetica').text(purchase.buyer?.name || '\u2014');
  if (purchase.buyer?.phone) doc.text(`  Phone: ${purchase.buyer.phone}`);

  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').text('Seller: ', { continued: true }).font('Helvetica').text(purchase.product?.seller?.name || '\u2014');
  if (purchase.product?.seller?.phone) doc.text(`  Phone: ${purchase.product.seller.phone}`);

  doc.moveDown(1);
}

function drawDigitalProduct(doc, purchase) {
  const product = purchase.product || {};
  doc.font('Helvetica-Bold').fontSize(11).text('Digital product');
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10);

  doc.text(`Item: ${product.title || '\u2014'}`);
  if (product.productType) doc.text(`Type: ${product.productType}`);
  doc.text(`Price: ${fmtMoney(product.price)}`);

  doc.moveDown(1);
}

// Streams a digital-purchase receipt PDF directly to an HTTP response.
function streamDigitalPurchaseReceiptPdf(purchase, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="marketbridge-purchase-${purchase.id}-receipt.pdf"`
  );

  doc.pipe(res);

  const payment = purchase.payment ? { ...purchase.payment, contextLabel: 'Digital purchase', refunds: purchase.payment.refunds || [] } : null;

  drawDigitalHeader(doc, purchase);
  drawDigitalParties(doc, purchase);
  drawDigitalProduct(doc, purchase);
  drawPaymentsTable(doc, payment ? [payment] : [], 'Payment for this purchase');
  drawFooter(doc, purchase.id, 'Purchase reference');

  doc.end();
}

// ============================================================================
// EARNINGS STATEMENT (PDF)
// ============================================================================
// The flip side of a Payment Receipt: not proof of what someone paid, but
// proof of what someone was paid — a seller, a hired transporter, or an
// inspector — after the platform's commission was deducted from their
// side of the same payment. Buyers never see this document; it belongs
// to the recipient (or admin) for their own income recordkeeping.
//
// Callers build a plain `ctx` object rather than passing raw Prisma
// records, since the shape of "who got paid for what" differs across
// marketplace sales, digital sales, hired transport and inspection —
// normalizing that in the route keeps this file's drawing code generic.
//
// Expected ctx shape:
// {
//   id, badgeLabel, itemLabel,
//   recipientRoleLabel, recipient: { name, phone },
//   counterpartyRoleLabel, counterparty: { name, phone },
//   grossAmount, currency, commissionRate, commissionAmount, netAmount,
//   paymentMethod, paymentReference, paymentStatus, paidAt,
//   refunds: [{ amount, currency, status, reason, createdAt, completedAt }],
//   relatedReferenceLabel, relatedReferenceId,
// }
// ============================================================================

function drawEarningsHeader(doc, ctx) {
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#176b3a').text('MarketBridge');
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#555555')
    .text('Ethiopian Agricultural & Digital Marketplace');

  doc.moveDown(1);
  doc.fillColor('#000000').fontSize(15).font('Helvetica-Bold').text('Earnings Statement');
  doc.moveDown(0.2);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#176b3a').text(ctx.badgeLabel);
  doc.moveDown(0.55);

  doc.fontSize(10).font('Helvetica').fillColor('#000000');
  doc.text(`Statement generated: ${fmtDate(new Date())}`);
  doc.text(`${ctx.relatedReferenceLabel}: ${ctx.relatedReferenceId}`);
  doc.text(`Payment status: ${ctx.paymentStatus}`);
  doc.text(`Paid on: ${fmtDate(ctx.paidAt)}`);

  doc.moveDown(1);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.75);
}

function drawEarningsParties(doc, ctx) {
  doc.font('Helvetica-Bold').fontSize(11).text('Parties');
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10);

  doc
    .font('Helvetica-Bold')
    .text(`${ctx.recipientRoleLabel} (you): `, { continued: true })
    .font('Helvetica')
    .text(ctx.recipient?.name || '\u2014');
  if (ctx.recipient?.phone) doc.text(`  Phone: ${ctx.recipient.phone}`);

  doc.moveDown(0.35);
  doc
    .font('Helvetica-Bold')
    .text(`Paid by (${ctx.counterpartyRoleLabel}): `, { continued: true })
    .font('Helvetica')
    .text(ctx.counterparty?.name || '\u2014');
  if (ctx.counterparty?.phone) doc.text(`  Phone: ${ctx.counterparty.phone}`);

  doc.moveDown(1);
}

function drawEarningsItem(doc, ctx) {
  doc.font('Helvetica-Bold').fontSize(11).text('For');
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10).text(ctx.itemLabel || '\u2014');
  doc.moveDown(1);
}

// The core of the document: gross the buyer paid, commission the platform
// held back, and the net that actually landed with the recipient — plus
// any refund, which claws the whole thing back rather than partially.
function drawEarningsBreakdown(doc, ctx) {
  doc.font('Helvetica-Bold').fontSize(11).text('Earnings breakdown');
  doc.moveDown(0.35);

  const left = doc.page.margins.left;
  const labelWidth = 260;

  function row(label, value, opts = {}) {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(opts.color || '#000000');
    const y = doc.y;
    doc.text(label, left, y, { width: labelWidth });
    doc.text(value, left + labelWidth, y, { width: doc.page.width - doc.page.margins.right - (left + labelWidth), align: 'right' });
    doc.moveDown(0.4);
  }

  row('Gross amount paid by buyer', fmtMoney(ctx.grossAmount, ctx.currency));
  row(`Platform commission (${fmtPercent(ctx.commissionRate)})`, `-${fmtMoney(ctx.commissionAmount, ctx.currency)}`, { color: '#a4372a' });
  doc
    .moveTo(left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.4);
  row('Net paid to you', fmtMoney(ctx.netAmount, ctx.currency), { bold: true });

  doc.moveDown(0.3);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666666')
    .text(
      `Method: ${ctx.paymentMethod || '\u2014'}  \u00b7  Ref: ${ctx.paymentReference || ctx.id}`,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  doc.fillColor('#000000');
  doc.moveDown(0.8);

  const refunds = ctx.refunds || [];
  if (refunds.length) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#a4372a').text('This payment was refunded to the buyer');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    refunds.forEach((refund) => {
      doc.text(
        `Refund of ${fmtMoney(refund.amount, refund.currency || ctx.currency)}  \u00b7  Status: ${refund.status}  \u00b7  ${fmtDate(refund.completedAt || refund.createdAt)}${refund.reason ? `  \u00b7  Reason: ${refund.reason}` : ''}`
      );
    });
    doc.moveDown(0.3);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#666666')
      .text(
        'A refund reverses this earning in full: the net amount above was clawed back from your payout rather than paid alongside it. A separate 0.7% platform penalty on the refunded amount is also recorded as platform revenue; it is not charged to you directly.',
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      );
    doc.fillColor('#000000');
    doc.moveDown(0.8);
  }
}

function drawEarningsFooter(doc, ctx) {
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#dddddd')
    .stroke();
  doc.moveDown(0.5);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666666')
    .text(
      'This statement was generated automatically by MarketBridge from its transaction records and reflects an amount paid to you through the platform, net of platform commission. It is provided to help with your own income recordkeeping and reporting, including tax filings; it is not a tax invoice and MarketBridge does not provide tax advice. Please verify formatting requirements with the receiving authority.',
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  doc.moveDown(0.5);
  doc.text(`Payment reference: ${ctx.id}`);
}

// Streams an earnings-statement PDF directly to an HTTP response.
function streamEarningsStatementPdf(ctx, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="marketbridge-earnings-${ctx.id}.pdf"`
  );

  doc.pipe(res);

  drawEarningsHeader(doc, ctx);
  drawEarningsParties(doc, ctx);
  drawEarningsItem(doc, ctx);
  drawEarningsBreakdown(doc, ctx);
  drawEarningsFooter(doc, ctx);

  doc.end();
}

module.exports = {
  streamOrderReceiptPdf,
  streamDigitalPurchaseReceiptPdf,
  streamEarningsStatementPdf,
  collectPayments,
  fmtMoney,
  fmtDate,
  fmtPercent,
  marketplaceLabel,
  SERVICE_LABELS,
};
