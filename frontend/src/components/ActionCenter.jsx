import React, { useMemo, useState } from 'react';
import api from '../api/client';

const ACTION_LABELS = {
  BUYER_DECISION_BUY: 'BUY – continue purchase',
  BUYER_DECISION_CANCEL: 'Cancel after inspection',
  REQUEST_INSPECTION: 'Request inspection',
  PAY_MARKETPLACE: 'Pay for goods',
  PAY_INSPECTION: 'Pay inspection fee',
  ARRANGE_TRANSPORT: 'Arrange transport',
  REVIEW_INSPECTION_QUOTES: 'Review inspection quotes',
  REVIEW_TRANSPORT_QUOTES: 'Review transport quotes',
  PAY_TRANSPORT: 'Pay transport',
  START_PICKUP: 'Start pickup',
  MARK_IN_TRANSIT: 'Mark in transit',
  MARK_DELIVERED: 'Mark delivered',
  CONFIRM_RECEIPT: 'Confirm receipt',
  CANCEL_ORDER: 'Cancel after inspection',
  START_INSPECTION: 'Start inspection',
  SUBMIT_INSPECTION_REPORT: 'Complete inspection report',
  RAISE_DISPUTE: 'Raise a dispute',
};

const scrollTarget = (code) => {
  if (code === 'PAY_MARKETPLACE' || code === 'PAY_INSPECTION' || code === 'PAY_TRANSPORT') return 'payment-center';
  if (code === 'ARRANGE_TRANSPORT' || code === 'REVIEW_TRANSPORT_QUOTES' || code === 'START_PICKUP' || code === 'MARK_IN_TRANSIT' || code === 'MARK_DELIVERED') return 'transport-section';
  if (code === 'REQUEST_INSPECTION' || code === 'REVIEW_INSPECTION_QUOTES' || code === 'START_INSPECTION' || code === 'SUBMIT_INSPECTION_REPORT') return 'inspection-section';
  if (code === 'CONFIRM_RECEIPT') return 'confirm-receipt';
  if (code === 'RAISE_DISPUTE') return 'raise-dispute';
  return 'next-action';
};

export default function ActionCenter({ workflow, onScroll, onActionComplete }) {
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  const actions = Array.isArray(workflow?.actions) ? workflow.actions : [];
  const readyActions = useMemo(() => actions.filter((action) => action?.ready), [actions]);
  const next = readyActions[0] || null;

  if (!workflow) return null;

  const doScroll = (code) => {
    const target = scrollTarget(code);
    if (onScroll) onScroll(target);
    else document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const run = async (action) => {
    if (!action || working) return;
    setError('');

    // The agricultural BUY action is a real server-side decision. It must
    // execute PATCH /orders/:id/buyer-decision before seller payment becomes
    // available. Do not merely scroll to Payment Center: /payments correctly
    // rejects a goods payment while buyerDecision is still null.

    // Payment controls have their own provider/session handling in OrderDetail.
    if (['PAY_INSPECTION', 'PAY_TRANSPORT'].includes(action.code)) {
      doScroll(action.code);
      return;
    }

    // Review/operational actions are intentionally routed to the relevant
    // section. The dedicated section owns the detailed controls and evidence.
    if (!action.route || action.code === 'REQUEST_INSPECTION' || action.code === 'ARRANGE_TRANSPORT' || action.code === 'REVIEW_INSPECTION_QUOTES' || action.code === 'REVIEW_TRANSPORT_QUOTES' || action.code === 'RAISE_DISPUTE') {
      doScroll(action.code);
      return;
    }

    if (action.code === 'CANCEL_ORDER') {
      const confirmed = window.confirm('Cancel this order? This cannot be undone.');
      if (!confirmed) return;
      setWorking(action.code);
      try {
        await api.patch(action.route.path, {});
        await onActionComplete?.();
      } catch (err) {
        setError(err?.response?.data?.error || err?.message || 'Could not cancel the order');
      } finally {
        setWorking('');
      }
      return;
    }

    // Movement/inspection state transitions can be executed from the workflow
    // when the backend exposes a concrete route and body.
    setWorking(action.code);
    try {
      const method = String(action.route.method || 'GET').toUpperCase();
      const path = action.route.path;
      const body = action.route.body;
      if (method === 'POST') await api.post(path, body);
      else if (method === 'PATCH') await api.patch(path, body);
      else if (method === 'PUT') await api.put(path, body);
      else await api.get(path);
      await onActionComplete?.();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || `Could not complete ${action.label || 'action'}`);
    } finally {
      setWorking('');
    }
  };

  const nextLabel = ACTION_LABELS[next?.code] || next?.label || 'Continue';
  const displayedNext = next;

  return (
    <div className="card next-action-card" id="next-action">
      <span className="eyebrow">NEXT STEP</span>
      <h2 style={{ marginBottom: 6 }}>
        {next ? nextLabel : 'Order workflow'}
      </h2>

      {workflow.currentStage && (
        <p className="muted" style={{ marginBottom: 10 }}>
          Stage: <strong>{String(workflow.currentStage).replaceAll('_', ' ')}</strong>
        </p>
      )}

      {next?.code === 'BUYER_DECISION_BUY' && (
        <p className="muted">
          Review the completed agricultural inspection, then choose BUY to unlock the seller payment.
        </p>
      )}

      {next?.code === 'PAY_MARKETPLACE' && (
        <p className="muted">
          BUY has been recorded. Choose the payment method below and start the seller payment checkout.
        </p>
      )}

      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}

      <div className="next-action-buttons" style={{ marginTop: 12 }}>
        {displayedNext ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={Boolean(working)}
            onClick={() => run(displayedNext)}
          >
            {working === displayedNext.code ? 'Working…' : (ACTION_LABELS[displayedNext.code] || displayedNext.label || 'Continue')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => doScroll('payment-center')}>
            Go to seller payment
          </button>
        )}
      </div>

      {readyActions.length > 1 && (
        <details style={{ marginTop: 12 }}>
          <summary>Other available actions</summary>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {readyActions.slice(1).map((action) => (
              <button
                key={`${action.code}-${action.inspectionRequestId || ''}`}
                type="button"
                className="btn btn-light"
                disabled={Boolean(working)}
                onClick={() => run(action)}
              >
                {ACTION_LABELS[action.code] || action.label || action.code}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
