import React from 'react';
import './RequestScopeSummary.css';

// ============================================================================
// REQUEST SCOPE SUMMARY
// ----------------------------------------------------------------------------
// One read-only summary of what a requester asked for, used on BOTH sides:
//   - requester: OrderDetail (inspection / transport cards)
//   - bidders:   inspector "available requests" and truck-owner "open jobs"
//
// Renders as a FLAT sub-section of the parent card — no box, no border,
// no shadow, no background. The parent card provides the frame.
// Reads only allow-listed workDetails fields — no free text, no contact info.
// ============================================================================

const CATEGORY_LABELS = {
  GENERAL_QUALITY: 'General quality and condition',
  AGRICULTURAL_PRODUCE: 'Agricultural produce quality',
  QUANTITY_VERIFICATION: 'Quantity and weight verification',
  DAMAGE_ASSESSMENT: 'Damage and packaging assessment',
  FUNCTIONAL_TESTING: 'Functionality and performance testing',
  CONFORMITY_CHECK: 'Specification and conformity check',
  SAFETY_COMPLIANCE: 'Safety-related checks',
};

// Labels keep their meaning but drop the "/" so they read cleanly in a
// stacked list (quality grading, size and weight, sampling and testing).
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

const HANDLING_LABELS = {
  FRAGILE: 'Fragile',
  KEEP_COOL: 'Keep cool',
  KEEP_DRY: 'Keep dry',
  THIS_SIDE_UP: 'This side up',
  VENTILATED: 'Ventilated',
  COVERED: 'Covered load',
};

const fmtDate = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
};

function Item({ name, children }) {
  if (children == null || children === '' || children === false) return null;
  return (
    <div className="rs-item">
      <span>{name}</span>
      <strong>{children}</strong>
    </div>
  );
}

// A titled list of plain text values (no pills, no box). Flows in the same
// 3-per-column grid as the facts above it.
function CheckList({ title, values }) {
  if (!Array.isArray(values) || !values.length) return null;
  return (
    <div className="rs-checks">
      <p className="rs-checks-title">{title}</p>
      <ul className="rs-checks-list">
        {values.map((v) => (
          <li key={v} className="rs-check">
            {v}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function InspectionRequestSummary({ inspection, title = 'Inspection scope' }) {
  const w = inspection?.workDetails;
  if (!w || typeof w !== 'object') return null;

  const quantity =
    w.quantityToInspect || (w.quantityValue ? `${w.quantityValue} ${w.quantityUnit || ''}`.trim() : null);
  const checks = Array.isArray(w.checks) ? w.checks.map((c) => CHECK_LABELS[c] || c) : [];
  const any = w.workCategory || quantity || w.lotCount || w.requiredBy || w.reportFormat || checks.length;
  if (!any) return null;

  return (
    <div className="rs-box" aria-label={title}>
      <p className="rs-title">{title}</p>

      <div className="rs-grid">
        <Item name="Category">{CATEGORY_LABELS[w.workCategory] || w.workCategory}</Item>
        <Item name="Quantity to inspect">{quantity}</Item>
        <Item name="Lots">{w.lotCount}</Item>
        <Item name="Deadline">{w.requiredBy && fmtDate(w.requiredBy)}</Item>
        <Item name="Report">{REPORT_LABELS[w.reportFormat] || w.reportFormat}</Item>
      </div>

      <CheckList title="Checks required" values={checks} />
    </div>
  );
}

// compact: hide route/load/capacity (already shown by the requester's own trip details)
export function TransportRequestSummary({ job, title = 'Transport request', compact = false }) {
  if (!job) return null;
  const w = job.workDetails && typeof job.workDetails === 'object' ? job.workDetails : {};
  const handling = Array.isArray(w.handling) ? w.handling.map((h) => HANDLING_LABELS[h] || h) : [];
  const route = job.pickupLocation && job.destination ? `${job.pickupLocation} → ${job.destination}` : null;

  return (
    <div className="rs-box" aria-label={title}>
      <p className="rs-title">{title}</p>

      <div className="rs-grid">
        {!compact && <Item name="Route">{route}</Item>}
        {!compact && <Item name="Load">{job.load}</Item>}
        <Item name="Weight">{w.weight}</Item>
        <Item name="Packages">{w.packageCount}</Item>
        {!compact && (
          <Item name="Min. capacity">
            {job.requiredCapacity != null ? `${job.requiredCapacity} t` : null}
          </Item>
        )}
        <Item name="Vehicle">{w.vehicleType}</Item>
        <Item name="Deadline">{w.deliveryDeadline && fmtDate(w.deliveryDeadline)}</Item>
        <Item name="Special requirements">{job.specialRequirements}</Item>
      </div>

      <CheckList title="Handling" values={handling} />
    </div>
  );
}
