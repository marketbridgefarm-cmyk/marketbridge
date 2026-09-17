import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';

// ============================================================================
// SERVER-DRIVEN WORKFLOW ACTIONS
// ============================================================================
// The backend is authoritative about readiness and authorization. This
// component executes actions that are safe to execute directly and routes to
// the existing specialist UI when a form/evidence workflow is required.
// ============================================================================

const ACTION_UI = {
  BUYER_DECISION_BUY: { kind: 'execute', label: 'BUY — continue purchase' },
  BUYER_DECISION_CANCEL: { kind: 'confirm-execute', label: 'Cancel after inspection' },
  PAY_MARKETPLACE: { kind: 'scroll', target: 'payment-center', label: 'Pay for goods' },
  PAY_INSPECTION: { kind: 'scroll', target: 'payment-center', label: 'Pay inspection fee' },
  PAY_TRANSPORT: { kind: 'scroll', target: 'payment-center', label: 'Pay transport' },
  ARRANGE_TRANSPORT: { kind: 'link', label: 'Arrange transport' },
  REVIEW_TRANSPORT_QUOTES: { kind: 'scroll', target: 'transport-section', label: 'Review transport quotes' },
  REVIEW_INSPECTION_QUOTES: { kind: 'scroll', target: 'inspection-section', label: 'Review inspection quotes' },
  START_INSPECTION: { kind: 'execute', label: 'Start inspection' },
  SUBMIT_INSPECTION_REPORT: { kind: 'link', to: '/dashboard/inspector', label: 'Complete inspection report' },
  START_PICKUP: { kind: 'execute', label: 'Start pickup' },
  MARK_IN_TRANSIT: { kind: 'execute', label: 'Mark in transit' },
  MARK_DELIVERED: { kind: 'execute', label: 'Mark delivered' },
  CONFIRM_RECEIPT: { kind: 'scroll', target: 'confirm-receipt', label: 'Confirm receipt' },
  RAISE_DISPUTE: { kind: 'scroll', target: 'raise-dispute', label: 'Raise a dispute' },
  CANCEL_ORDER: { kind: 'execute', label: 'Cancel order' },
};

const ACTOR_LABEL = {
  BUYER: 'the buyer',
  SELLER: 'the seller',
  BUYER_OR_SELLER: 'the buyer or seller',
  TRUCK_OWNER: 'the transporter',
  INSPECTOR: 'the inspector',
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
      await api.request({ method, url: action.route.path, ...(config || {}) });
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
      return;
    }
    navigate(`/orders/${orderId}/transport`);
  }

  return (
    <div>
      {localError && <div className="alert alert-error" role="alert">{localError}</div>}
      <div className="next-action-buttons">
        {visible.map((action, index) => {
          const ui = ACTION_UI[action.code];
          const key = `${action.code}-${action.inspectionRequestId || index}`;
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
                  if (window.confirm('Cancel this agricultural transaction after reviewing the inspection report? This cannot be undone.')) {
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
