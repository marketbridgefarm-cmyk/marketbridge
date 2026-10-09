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

  return (
    <div className="ld-inspection-scope">
      <p className="ld-inspection-scope-eyebrow">INSPECTION SCOPE</p>
      <p className="ld-inspection-scope-title">What the inspection covers</p>

      <div className="ld-inspection-scope-grid">
        {workCategory && (
          <div>
            <span>Scope</span>
            <strong>{CATEGORY_LABELS[workCategory] || workCategory}</strong>
          </div>
        )}
        
        {/* Render exact figure instead of a range */}
        {quantityValue && (
          <div>
            <span>Quantity</span>
            <strong>{quantityValue} {quantityUnit || 'kg'}</strong>
          </div>
        )}

        {lotCount != null && lotCount !== '' && (
          <div>
            <span>Lots</span>
            <strong>{lotCount}</strong>
          </div>
        )}
        {reportFormat && (
          <div>
            <span>Report</span>
            <strong>{REPORT_LABELS[reportFormat] || reportFormat}</strong>
          </div>
        )}
        {requiredBy && (
          <div>
            <span>Deadline</span>
            <strong>{new Date(requiredBy).toLocaleString()}</strong>
          </div>
        )}
        {hasChecks && (
          <div className="ld-inspection-scope-full">
            <span>Checks required</span>
            <div className="ld-inspection-scope-chips">
              {checks.map((c) => (
                <span key={c} className="ld-inspection-scope-chip">
                  {CHECK_LABELS[c] || c}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
