import React from 'react';

import { DEADLINE_WINDOWS, QUANTITY_VALUES, deadlineFromWindow } from '../../components/RequestOptions.js';
import { Button } from './OrderDetailPrimitives.jsx';

// ============================================================================
// INSPECTION REQUEST FORM
// ============================================================================
//
// Extracted from OrderDetail.jsx. The popup form for opening a new
// inspection competition. Rendered inside a Modal by the page component;
// the parent manages all state via workDetails / setWorkDetails.
//
// Same props, same behavior, same rendering. Pure relocation.
// ============================================================================

export default function InspectionRequestForm({ workDetails, setWorkDetails, requesting, request, isBuyer, onCancel }) {
  return (
    <div className="od-inspection-work-form">
      <h3>Describe the inspection work</h3>
      <p className="muted">
        Inspectors will see these requirements before submitting a bid. Be specific so their fees
        cover the same work.
      </p>

      <label>Inspection category
        <select
          value={workDetails.workCategory || 'GENERAL_QUALITY'}
          onChange={(e) => setWorkDetails({ ...workDetails, workCategory: e.target.value })}
        >
          <option value="GENERAL_QUALITY">General quality and condition</option>
          <option value="AGRICULTURAL_PRODUCE">Agricultural produce quality</option>
          <option value="QUANTITY_VERIFICATION">Quantity and weight verification</option>
          <option value="DAMAGE_ASSESSMENT">Damage and packaging assessment</option>
          <option value="FUNCTIONAL_TESTING">Functionality / performance testing</option>
          <option value="CONFORMITY_CHECK">Specification / conformity check</option>
          <option value="SAFETY_COMPLIANCE">Safety-related checks</option>
        </select>
      </label>

      <div className="od-form-grid">
        <label>
          Quantity to inspect
          <div className="od-quantity-row">
            <select
              className="field"
              aria-label="Quantity to inspect"
              value={workDetails.quantityValue || ''}
              onChange={(e) => setWorkDetails({ ...workDetails, quantityValue: e.target.value })}
            >
              <option value="">Select quantity…</option>
              {QUANTITY_VALUES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <select
              className="field"
              value={workDetails.quantityUnit || 'kg'}
              onChange={(e) => setWorkDetails({ ...workDetails, quantityUnit: e.target.value })}
            >
              <option value="kg">kg</option>
              <option value="tons">tons</option>
              <option value="quintals">quintals</option>
              <option value="units">units</option>
              <option value="crates">crates</option>
              <option value="bags">bags</option>
            </select>
          </div>
        </label>

        <label>Number of lots / batches
          <select
            value={
              workDetails.lotCount === undefined || workDetails.lotCount === null
                ? ''
                : String(workDetails.lotCount)
            }
            onChange={(e) => {
              const raw = e.target.value;
              setWorkDetails({
                ...workDetails,
                lotCount: raw === '' ? '' : Number(raw),
              });
            }}
          >
            <option value="">Select number of lots…</option>
            <option value="1">1 lot</option>
            <option value="2">2 lots</option>
            <option value="3">3 lots</option>
            <option value="4">4 lots</option>
            <option value="5">5 lots</option>
            <option value="6">6 lots</option>
            <option value="7">7 lots</option>
            <option value="8">8 lots</option>
            <option value="9">9 lots</option>
            <option value="10">10 lots</option>
            <option value="15">More than 10 lots (approx. 15)</option>
            <option value="20">More than 20 lots (approx. 20)</option>
          </select>
        </label>

        <label>Inspection deadline
          <select
            className="field"
            value={workDetails.deadlineWindow || ''}
            onChange={(e) =>
              setWorkDetails({
                ...workDetails,
                deadlineWindow: e.target.value,
                requiredBy: deadlineFromWindow(e.target.value),
              })
            }
          >
            <option value="">No deadline</option>
            {DEADLINE_WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>{w.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="od-inspection-checks">
        Checks required (hold Ctrl / Cmd to select multiple)
        <select
          multiple
          size={7}
          className="od-inspection-checks-select"
          value={Array.isArray(workDetails.checks) ? workDetails.checks : []}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
            setWorkDetails({ ...workDetails, checks: selected });
          }}
        >
          <option value="QUALITY_GRADE">Quality / grading</option>
          <option value="SIZE_WEIGHT">Size / weight</option>
          <option value="MOISTURE">Moisture (if applicable)</option>
          <option value="VISIBLE_DEFECTS">Visible defects / damage</option>
          <option value="PACKAGING">Packaging condition</option>
          <option value="SAMPLING">Sampling / testing</option>
          <option value="PHOTOGRAPHS">Photos / evidence</option>
        </select>
      </label>

      <p className="muted small">
        {Array.isArray(workDetails.checks) && workDetails.checks.length > 0
          ? `Selected: ${workDetails.checks.map((c) => c.replaceAll('_', ' ').toLowerCase()).join(', ')}`
          : 'No checks selected yet.'}
      </p>

      <label>Report format
        <select
          value={workDetails.reportFormat || 'CHECKLIST_PHOTOS'}
          onChange={(e) => setWorkDetails({ ...workDetails, reportFormat: e.target.value })}
        >
          <option value="CHECKLIST_PHOTOS">Checklist, findings and photos</option>
          <option value="MEASUREMENTS">Measurements and test results</option>
          <option value="PASS_FAIL">Pass / fail against agreed criteria</option>
          <option value="FULL_REPORT">Full structured inspection report</option>
        </select>
      </label>

      <div className="od-actions">
        <Button
          variant="primary"
          disabled={requesting || !workDetails.quantityValue}
          busy={requesting}
          busyText="Requesting…"
          onClick={() => request(isBuyer ? 'BUYER_REQUESTED' : 'SELLER_REQUESTED')}
        >
          Open inspection competition
        </Button>
        <Button variant="light" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
