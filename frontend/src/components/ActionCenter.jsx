import React from 'react';
import WorkflowActions from './WorkflowActions.jsx';

// ============================================================================
// ACTION CENTER
// ============================================================================
// Displays the current user's available next actions for an order, driven
// entirely by GET /orders/:id/workflow (see orderWorkflowService.js on the
// backend). This replaces per-role hand-written "what happens next" copy —
// the stage, the responsible party, and which actions are ready all come
// from the server so the page can't drift out of sync with the real rules.
// ============================================================================

const STAGE_COPY = {
  PENDING_PAYMENT: 'Waiting for the buyer to pay for the goods.',
  ARRANGING_TRANSPORT: 'Transport still needs to be arranged.',
  PAYMENT: 'One or more required payments are still outstanding.',
  PICKUP_READY: 'All required payments are complete. The transporter can start pickup.',
  PICKED_UP: 'The goods have been picked up. Waiting for the trip to start.',
  IN_TRANSIT: 'The goods are in transit.',
  AWAITING_RECEIPT: 'The goods have been delivered. The buyer needs to confirm receipt.',
  COMPLETED: 'This order is complete.',
  DISPUTED: 'This order has an open dispute.',
  CANCELLED: 'This order has been cancelled.',
};

const ACTOR_LABEL = {
  BUYER: 'Buyer',
  SELLER: 'Seller',
  BUYER_OR_SELLER: 'Buyer or seller',
  TRUCK_OWNER: 'Transporter',
  INSPECTOR: 'Inspector',
  ADMIN: 'Administrator',
};

export default function ActionCenter({ workflow, onScroll }) {
  if (!workflow) return null;

  const { currentStage, nextActor, viewerRole, actions } = workflow;

  const viewerActions = (actions || []).filter((a) => a.viewerCanPerform);
  const viewerHasReadyAction = viewerActions.some((a) => a.ready);

  return (
    <div className="card next-action-card" id="next-action">
      <div className="row-between">
        <div>
          <span className="eyebrow">NEXT STEP</span>
          <h2 style={{ marginBottom: 6 }}>What happens next?</h2>
          <p className="muted">
            {STAGE_COPY[currentStage] || 'Continue the order from the sections below.'}
            {nextActor && !viewerHasReadyAction && (
              <> Currently waiting on <strong>{ACTOR_LABEL[nextActor] || nextActor}</strong>.</>
            )}
          </p>
        </div>
        <span className="badge">{currentStage.replace(/_/g, ' ')}</span>
      </div>

      {viewerRole === 'OTHER' ? (
        <p className="muted">You are viewing this order without an active role in its workflow.</p>
      ) : (
        <div className="next-action-panel">
          <strong>Your next step{viewerActions.length === 1 ? '' : 's'}</strong>
          {viewerActions.length === 0 ? (
            <p>Nothing is required from you right now.</p>
          ) : (
            <WorkflowActions
              actions={viewerActions}
              orderId={workflow.orderId}
              onScroll={onScroll}
            />
          )}
        </div>
      )}
    </div>
  );
}
