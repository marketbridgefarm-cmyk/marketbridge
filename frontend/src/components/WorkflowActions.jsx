import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';

// ============================================================================
// SERVER-DRIVEN WORKFLOW ACTIONS
// ============================================================================
// The backend is authoritative about readiness and authorization. This
// component executes actions that are safe to execute directly and routes to
// the existing specialist UI when a form/evidence workflow is required.
//
// Action codes come from services/orderWorkflowService.js `buildActions`.
// Keep ACTION_UI in sync — any code emitted by the read model that is not
// listed here is silently hidden from the Action Center.
// ============================================================================

const ACTION_UI = {
  // ── Buyer decisions ──────────────────────────────────────────────────
  BUYER_DECISION_BUY: { kind: 'execute', label: 'BUY — continue purchase' },
  BUYER_DECISION_CANCEL: { kind: 'confirm-execute', label: 'Cancel after inspection' },

  // ── Payments ─────────────────────────────────────────────────────────
  PAY_MARKETPLACE: { kind: 'scroll', target: 'payment-center', label: 'Pay for goods' },
  PAY_INSPECTION: { kind: 'scroll', target: 'payment-center', label: 'Pay inspection fee' },
  PAY_TRANSPORT: { kind: 'scroll', target: 'payment-center', label: 'Pay transport' },

  // ── Transport arrangement ────────────────────────────────────────────
  ARRANGE_TRANSPORT: { kind: 'scroll', target: 'transport-section', label: 'Arrange transport' },

  // ── Negotiation — selection and turn-based response ──────────────────
  SELECT_INSPECTION_QUOTE: { kind: 'scroll', target: 'inspection-section', label: 'Select an inspector' },
  SELECT_TRANSPORT_QUOTE: { kind: 'scroll', target: 'transport-section', label: 'Select a transporter' },
  RESPOND_INSPECTION_NEGOTIATION: { kind: 'scroll', target: 'inspection-section', label: 'Respond to inspector quote' },
  RESPOND_TRANSPORT_NEGOTIATION: { kind: 'scroll', target: 'transport-section', label: 'Respond to transport quote' },

  // ── Release (requester-side) ─────────────────────────────────────────
  RELEASE_INSPECTION_AGREEMENT: { kind: 'scroll', target: 'inspection-section', label: 'Release inspector agreement' },
  RELEASE_TRANSPORT_AGREEMENT: { kind: 'scroll', target: 'transport-section', label: 'Release transporter agreement' },
  RELEASE_SILENT_INSPECTOR: { kind: 'scroll', target: 'inspection-section', label: 'Release silent inspector' },
  RELEASE_SILENT_TRUCK_OWNER: { kind: 'scroll', target: 'transport-section', label: 'Release silent truck owner' },

  // ── Provider cancels own provisional agreement ───────────────────────
  PROVIDER_CANCEL_INSPECTION: { kind: 'scroll', target: 'inspection-section', label: 'Cancel provisional agreement' },
  PROVIDER_CANCEL_TRANSPORT: { kind: 'scroll', target: 'transport-section', label: 'Cancel provisional agreement' },

  // ── Seller confirmations ─────────────────────────────────────────────
  // ── Inspection request ───────────────────────────────────────────────
  REQUEST_INSPECTION: { kind: 'scroll', target: 'inspection-section', label: 'Request an inspection' },

// ── Seller confirmations ─────────────────────────────────────────────
  CONFIRM_INSPECTION: { kind: 'execute', label: 'Confirm inspector and fee' },
  DECLINE_INSPECTION: { kind: 'confirm-execute', label: 'Decline inspector and fee' },
  CONFIRM_INSPECTOR_ARRIVAL: { kind: 'execute', label: 'Confirm inspector on site' },
  CONFIRM_TRANSPORT_PREPARATION: { kind: 'execute', label: 'Confirm transporter preparation' },
  CONFIRM_TRUCK_ARRIVAL: { kind: 'execute', label: 'Confirm truck on site' },

  // ── Inspection work (inspector) ──────────────────────────────────────
  START_INSPECTION: { kind: 'execute', label: 'Start inspection' },
  SUBMIT_INSPECTION_REPORT: { kind: 'link', to: '/dashboard/inspector', label: 'Complete inspection report' },

  // ── Transport work (transporter) ─────────────────────────────────────
  CONFIRM_LOADING: { kind: 'execute', label: 'Approve loading report' },
  START_PICKUP: { kind: 'execute', label: 'Start loading / pickup' },
  MARK_IN_TRANSIT: { kind: 'execute', label: 'Mark in transit' },
  MARK_DELIVERED: { kind: 'execute', label: 'Mark delivered' },

  // ── Order lifecycle ──────────────────────────────────────────────────
  CONFIRM_RECEIPT: { kind: 'scroll', target: 'confirm-receipt', label: 'Confirm receipt' },
  RAISE_DISPUTE: { kind: 'scroll', target: 'raise-dispute', label: 'Raise a dispute' },
  CANCEL_ORDER: { kind: 'execute', label: 'Cancel order' },

  // ── Recovery ─────────────────────────────────────────────────────────
  REQUEST_INSPECTION_RECOVERY: { kind: 'execute', label: 'Request fresh inspection form' },
  REQUEST_TRANSPORT_RECOVERY: { kind: 'execute', label: 'Request fresh transport form' },
  REQUEST_OFFER_RECOVERY: { kind: 'execute', label: 'Request fresh offer competition' },
};

const ACTOR_LABEL = {
  BUYER: 'the buyer',
  SELLER: 'the seller',
  BUYER_OR_SELLER: 'the buyer or seller',
  TRUCK_OWNER: 'the transporter',
  INSPECTOR: 'the inspector',
  SELLER_OR_TRUCK_OWNER: 'the seller or transporter',
  REQUESTER: 'the requester',
  PROVIDER: 'the provider',
  ADMIN: 'an administrator',
};

function errorMessage(error, fallback) {
  return error?.response?.data?.error || error?.response?.data?.message || fallback;
}

export default function WorkflowActions({
  actions,
  orderId,
  onScroll,
  onActionComplete,
  emphasizeFirst = true,
}) {
  const navigate = useNavigate();
  const [busyCode, setBusyCode] = useState('');
  const [localError, setLocalError] = useState('');

  const visible = (actions || []).filter((a) => ACTION_UI[a.code]);
  if (visible.length === 0) return null;

  async function execute(action) {
    if (!action?.route?.method || !action?.route?.path) return;

    setBusyCode(action.code);
    setLocalError('');
    let actionError = null;
    try {
      const method = action.route.method.toLowerCase();
      const config = action.route.body ? { data: action.route.body } : undefined;
      // Buyer BUY/CANCEL is an immutable decision. Reuse one deterministic key
      // for that order/decision so a lost response can be safely retried and
      // replay the original 200 response instead of turning the retry into a
      // misleading 409 "already recorded" message.
      const deterministicKey = action.code.startsWith('BUYER_DECISION_')
        ? `order:${orderId}:${action.code}`
        : null;
      const randomKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const headers = { 'Idempotency-Key': deterministicKey || randomKey };
      await api.request({ method, url: action.route.path, headers, ...(config || {}) });
    } catch (error) {
      actionError = error;
      setLocalError(errorMessage(error, `Could not complete: ${action.label || action.code}`));
    } finally {
      // Never keep the button in `Working…` while the follow-up page refresh
      // is running. A slow/stuck GET must not make a successfully submitted
      // workflow action look like it is still being submitted.
      setBusyCode('');
    }

    // Refresh the server-authoritative workflow after the mutation, but do
    // not make the button depend on the refresh completing. This is also
    // important when the mutation returns a useful 4xx error: the error must
    // be visible immediately instead of being hidden behind a hanging refresh.
    try {
      await onActionComplete?.(action, actionError ? { error: actionError } : undefined);
    } catch (refreshError) {
      if (!actionError) {
        setLocalError(errorMessage(refreshError, 'The action completed, but the order could not be refreshed. Please refresh the page.'));
      }
    }
  }

  function handleLink(action, ui) {
    if (ui.to) {
      const separator = ui.to.includes('?') ? '&' : '?';
      if (action.inspectionRequestId && ui.to === '/dashboard/inspector') {
        navigate(`${ui.to}${separator}inspectionId=${encodeURIComponent(action.inspectionRequestId)}`);
        return;
      }
      navigate(ui.to);
    }
    // Every remaining ACTION_UI entry with kind 'link' sets `to`. There is
    // intentionally no other fallback here.
  }

  return (
    <div>
      {localError && <div className="alert alert-error" role="alert">{localError}</div>}
      <div className="next-action-buttons">
        {visible.map((action, index) => {
          const ui = ACTION_UI[action.code];
          const key = `${action.code}-${action.inspectionRequestId || action.transportJobId || action.quoteId || index}`;
          const primary = emphasizeFirst && index === 0 && action.enabled;
          const btnClass = `btn ${primary ? 'btn-primary' : 'btn-outline'} btn-sm`;
          const isBusy = busyCode === action.code;

          if (!action.enabled) {
            return (
              <span key={key} className="workflow-action-pending muted">
                {ui.label} — waiting on {ACTOR_LABEL[action.actorRole] || 'the responsible party'}
                {action.reason ? ` (${action.reason})` : ''}
              </span>
            );
          }

          if (ui.kind === 'link') {
            return (
              <button
                key={key}
                type="button"
                className={btnClass}
                onClick={() => handleLink(action, ui)}
              >
                {ui.label}
              </button>
            );
          }

          if (ui.kind === 'confirm-execute') {
            return (
              <button
                key={key}
                type="button"
                className={btnClass}
                disabled={isBusy}
                onClick={() => {
                  if (window.confirm(`Cancel this agricultural transaction after reviewing the inspection report? This cannot be undone.`)) {
                    execute(action);
                  }
                }}
              >
                {isBusy ? 'Working…' : ui.label}
              </button>
            );
          }

          if (ui.kind === 'execute') {
            return (
              <button
                key={key}
                type="button"
                className={btnClass}
                disabled={isBusy}
                onClick={() => execute(action)}
              >
                {isBusy ? 'Working…' : ui.label}
              </button>
            );
          }

          return (
            <button
              key={key}
              type="button"
              className={btnClass}
              onClick={() => onScroll?.(ui.target)}
            >
              {ui.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
