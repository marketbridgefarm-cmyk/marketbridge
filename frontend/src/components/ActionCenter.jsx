import React, { useMemo, useState } from 'react';
import api from '../api/client';

const ACTION_LABELS = {
  PAY_MARKETPLACE: 'BUY – continue purchase',
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
  if (code === 'REVIEW_INSPECTION_QUOTES' || code === 'START_INSPECTION' || code === 'SUBMIT_INSPECTION_REPORT') return 'inspection-section';
  if (code === 'CONFIRM_RECEIPT') return 'confirm-receipt';
  if (code === 'RAISE_DISPUTE') return 'raise-dispute';
  return 'next-action';
};

export default function ActionCenter({ workflow, onScroll, onActionComplete }) {
  const [working, setWorking] = useState('');
  const [continued, setContinued] = useState(false);
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

    // BUY is a decision gate, not a second payment endpoint. The order already
    // exists after the seller accepts the offer. Clicking BUY therefore moves
    // the buyer to the seller-payment controls instead of creating a duplicate
    // payment intent or leaving the button spinning forever.
    if (action.code === 'PAY_MARKETPLACE') {
      setContinued(true);
      doScroll(action.code);
      return;
    }

    // Payment controls have their own provider/session handling in OrderDetail.
    if (['PAY_INSPECTION', 'PAY_TRANSPORT'].includes(action.code)) {
      doScroll(action.code);
      return;
    }

    // Review/operational actions are intentionally routed to the relevant
    // section. The dedicated section owns the detailed controls and evidence.
    if (!action.route || action.code === 'ARRANGE_TRANSPORT' || action.code === 'REVIEW_INSPECTION_QUOTES' || action.code === 'REVIEW_TRANSPORT_QUOTES' || action.code === 'RAISE_DISPUTE') {
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
  const displayedNext = continued && next?.code === 'PAY_MARKETPLACE'
    ? null
    : next;

  return (
    <div className="card next-action-card" id="next-action">
      <span className="eyebrow">NEXT STEP</span>
      <h2 style={{ marginBottom: 6 }}>
        {continued && next?.code === 'PAY_MARKETPLACE' ? 'Seller payment' : next ? nextLabel : 'Order workflow'}
      </h2>

      {workflow.currentStage && (
        <p className="muted" style={{ marginBottom: 10 }}>
          Stage: <strong>{String(workflow.currentStage).replaceAll('_', ' ')}</strong>
        </p>
      )}

      {next?.code === 'PAY_MARKETPLACE' && !continued && (
        <p className="muted">
          Review the completed agricultural inspection, then choose BUY to continue to seller payment. No payment is created by this button.
        </p>
      )}

      {continued && next?.code === 'PAY_MARKETPLACE' && (
        <p className="muted">
          BUY selected. The seller payment controls are below. Choose the payment method and start checkout there.
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
