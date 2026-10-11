import React from 'react';
import './ListingInspectionScope.css';

// ============================================================================
// LISTING INSPECTION SCOPE
// ----------------------------------------------------------------------------
// Read-only summary of the scope of the current inspection on a listing.
// Feeds from the listing payload the detail page already loads — no extra
// network request. Never shows contact info; that lives only in
// InspectionCoordination, which is gated to the seller + inspector.
//
// SECURITY: All fields here are structured (enums, numbers, dates). No free
// text is allowed, preventing bidders from leaking contact info via the
// quantity field or other inputs.
//
// This component renders as a SECTION of the parent card — no wrapper
// surface, no border. It relies on the parent card for its background.
// ============================================================================

const CATEGORY_LABELS = {
  GENERAL_QUALITY: 'General quality and condition',
  AGRICULTURAL_PRODUCE: 'Agricultural produce quality',
  QUANTITY_VERIFICATION: 'Quantity and weight verification',
  DAMAGE_ASSESSMENT: 'Damage and packaging assessment',
  FUNCTIONAL_TESTING: 'Functionality / performance testing',
  CONFORMITY_CHECK: 'Specification / conformity check',
  SAFETY_COMPLIANCE: 'Safety-related checks',
};

const CHECK_LABELS = {
  QUALITY_GRADE: 'Quality / grading',
  SIZE_WEIGHT: 'Size / weight',
  MOISTURE: 'Moisture',
  VISIBLE_DEFECTS: 'Visible defects / damage',
  PACKAGING: 'Packaging condition',
  SAMPLING: 'Sampling / testing',
  PHOTOGRAPHS: 'Photos / evidence',
};

const REPORT_LABELS = {
  CHECKLIST_PHOTOS: 'Checklist, findings and photos',
  MEASUREMENTS: 'Measurements and test results',
  PASS_FAIL: 'Pass / fail against agreed criteria',
  FULL_REPORT: 'Full structured inspection report',
};

export default function ListingInspectionScope({ inspection }) {
  const workDetails = inspection?.workDetails;
  if (!inspection || !workDetails || typeof workDetails !== 'object') return null;

  const {
    workCategory,
    quantityValue,
    quantityUnit,
    lotCount,
    checks,
    reportFormat,
    requiredBy,
  } = workDetails;

  const hasChecks = Array.isArray(checks) && checks.length > 0;

  const hasAnyField =
    workCategory ||
    quantityValue ||
    lotCount ||
    hasChecks ||
    reportFormat ||
    requiredBy;

  if (!hasAnyField) return null;

  // Facts are the discrete key/value rows. They flow top → bottom and spill
  // into a new column after the 3rd row (grid-auto-flow: column).
  const facts = [];
  if (workCategory) {
    facts.push({
      key: 'category',
      label: 'Category',
      value: CATEGORY_LABELS[workCategory] || workCategory,
    });
  }
  if (quantityValue) {
    facts.push({
      key: 'quantity',
      label: 'Quantity to inspect',
      value: `${quantityValue} ${quantityUnit || 'kg'}`,
    });
  }
  if (lotCount != null && lotCount !== '') {
    facts.push({ key: 'lots', label: 'Lots', value: lotCount });
  }
  if (requiredBy) {
    facts.push({
      key: 'deadline',
      label: 'Deadline',
      value: new Date(requiredBy).toLocaleString(),
    });
  }
  if (reportFormat) {
    facts.push({
      key: 'report',
      label: 'Report',
      value: REPORT_LABELS[reportFormat] || reportFormat,
    });
  }

  return (
    <section className="ld-inspection-scope" aria-label="Inspection scope">
      <header className="ld-inspection-scope-head">
        <span className="ld-inspection-scope-eyebrow">INSPECTION SCOPE</span>
        <h4 className="ld-inspection-scope-title">What the inspection covers</h4>
      </header>

      {facts.length > 0 && (
        <div className="ld-inspection-scope-facts">
          {facts.map((f) => (
            <div key={f.key} className="ld-inspection-scope-fact">
              <span>{f.label}</span>
              <strong>{f.value}</strong>
            </div>
          ))}
        </div>
      )}

      {hasChecks && (
        <div className="ld-inspection-scope-checks">
          <span className="ld-inspection-scope-checks-label">Checks required</span>
          <div className="ld-inspection-scope-chips">
            {checks.map((c) => (
              <span key={c} className="ld-inspection-scope-chip">
                {CHECK_LABELS[c] || c}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
