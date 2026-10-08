'use strict';

/**
 * Shared report contract for InspectionReport and TransportLoadingReport.
 * Domain-specific fields remain on each report model; this envelope is the
 * common lifecycle/audit surface consumed by workflow and UI layers.
 */
function buildBuyerReportEnvelope(report, kind, extra = {}) {
  if (!report) return null;
  return {
    kind,
    id: report.id,
    reportVersion: report.reportVersion || 1,
    submittedAt: report.submittedAt || report.createdAt || null,
    buyerReviewStatus: report.buyerReviewStatus || 'PENDING',
    buyerReviewedAt: report.buyerReviewedAt || null,
    buyerReviewedById: report.buyerReviewedById || null,
    buyerReviewNotes: report.buyerReviewNotes || null,
    ...extra,
  };
}

module.exports = { buildBuyerReportEnvelope };
