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

// Every payment touching this order — the marketplace/goods payment itself
// plus any inspection or transport fees — deduplicated by id, since some
// of these relations can overlap.
function collectPayments(order) {
  const seen = new Set();
  const rows = [];

  const add = (payment, contextLabel) => {
    if (!payment || seen.has(payment.id)) return;
    seen.add(payment.id);
    rows.push({ ...payment, contextLabel });
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
  doc.moveDown(0.75);

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

function drawPaymentsTable(doc, payments) {
  doc.font('Helvetica-Bold').fontSize(11).text('Payments on this order');
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
  doc.moveDown(1);
}

function drawFooter(doc, order) {
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
      'This receipt was generated automatically by MarketBridge from its transaction records and reflects the payment amounts, methods and platform commission recorded for this order. It is provided to help with recordkeeping and reporting, including quarterly filings; it is not a tax invoice and MarketBridge does not provide tax advice. Please verify formatting requirements with the receiving authority.',
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  doc.moveDown(0.5);
  doc.text(`Order reference: ${order.id}`);
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
  drawFooter(doc, order);

  doc.end();
}

module.exports = { streamOrderReceiptPdf, collectPayments, fmtMoney, fmtDate, fmtPercent };
