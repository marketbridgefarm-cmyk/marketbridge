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
// Layout: head (title + deadline chip) → category hero → stat tiles →
// checks list. Renders as a SECTION of the parent card — no outer frame.
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
  QUALITY_GRADE: 'Quality grading',
  SIZE_WEIGHT: 'Size and weight',
  MOISTURE: 'Moisture',
  VISIBLE_DEFECTS: 'Visible defects and damage',
  PACKAGING: 'Packaging condition',
  SAMPLING: 'Sampling and testing',
  PHOTOGRAPHS: 'Photos and evidence',
};

const REPORT_LABELS = {
  CHECKLIST_PHOTOS: 'Checklist, findings and photos',
  MEASUREMENTS: 'Measurements and test results',
  PASS_FAIL: 'Pass or fail against agreed criteria',
  FULL_REPORT: 'Full structured inspection report',
};

function formatDeadline(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

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
  const deadline = requiredBy ? formatDeadline(requiredBy) : null;

  const hasAnyField =
    workCategory ||
    quantityValue ||
    lotCount ||
    hasChecks ||
    reportFormat ||
    deadline;

  if (!hasAnyField) return null;

  const stats = [];
  if (quantityValue) {
    stats.push({
      key: 'quantity',
      label: 'Quantity to inspect',
      value: `${quantityValue} ${quantityUnit || 'kg'}`,
    });
  }
  if (lotCount != null && lotCount !== '') {
    stats.push({ key: 'lots', label: 'Lots', value: lotCount });
  }
  if (reportFormat) {
    stats.push({
      key: 'report',
      label: 'Report',
      value: REPORT_LABELS[reportFormat] || reportFormat,
    });
  }

  return (
    <div className="ld-inspection-scope" aria-label="Inspection scope">
      <header className="ld-inspection-scope-head">
        <div className="ld-inspection-scope-headtext">
          <span className="ld-inspection-scope-eyebrow">Scope to inspect</span>
          <h3 className="ld-inspection-scope-title">What the inspection covers</h3>
        </div>
        {deadline && (
          <div className="ld-inspection-scope-deadline">
            <span>Deadline</span>
            <strong>{deadline}</strong>
          </div>
        )}
      </header>

      {workCategory && (
        <div className="ld-inspection-scope-hero">
          <span>Category</span>
          <strong>{CATEGORY_LABELS[workCategory] || workCategory}</strong>
        </div>
      )}

      {stats.length > 0 && (
        <div className="ld-inspection-scope-stats">
          {stats.map((s) => (
            <div key={s.key} className="ld-inspection-scope-stat">
              <span>{s.label}</span>
              <strong>{s.value}</strong>
            </div>
          ))}
        </div>
      )}

      {hasChecks && (
        <div className="ld-inspection-scope-checks">
          <div className="ld-inspection-scope-checks-head">
            <span className="ld-inspection-scope-checks-label">Checks required</span>
            <span className="ld-inspection-scope-checks-count">
              {checks.length} {checks.length === 1 ? 'check' : 'checks'}
            </span>
          </div>
          <ul className="ld-inspection-scope-checks-list">
            {checks.map((c) => (
              <li key={c} className="ld-inspection-scope-check">
                {CHECK_LABELS[c] || c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
