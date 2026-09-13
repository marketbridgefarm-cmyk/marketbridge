import React from 'react';
import { Link } from 'react-router-dom';

// ============================================================================
// WORKFLOW ACTIONS
// ============================================================================
// Renders the `actions` array returned by GET /orders/:id/workflow as a
// consistent list of buttons/links. This component does not decide *whether*
// an action is available — that already happened on the backend
// (orderWorkflowService.js). It only decides *how* to trigger each action
// code: some map to an existing on-page control (scroll to it), some
// navigate to another page, and the rest render nothing so we never point
// the user at a dead link.
//
// Reusable anywhere an order's workflow actions need to be shown (order
// detail page today; dashboards can reuse the same component later).
// ============================================================================

// Action codes this component knows how to trigger, and how.
// `kind: 'scroll'` -> scroll to an existing on-page section that already
//   contains the real control (keeps a single source of execution logic).
// `kind: 'link'`   -> navigate to another page that handles it.
// Anything not listed here is display-only (shown in the "waiting on" line
// via ActionCenter) and renders no button.
const ACTION_UI = {
  PAY_MARKETPLACE: { kind: 'scroll', target: 'payment-center', label: 'Pay for goods' },
  PAY_INSPECTION: { kind: 'scroll', target: 'payment-center', label: 'Pay inspection fee' },
  PAY_TRANSPORT: { kind: 'scroll', target: 'payment-center', label: 'Pay transport' },
  ARRANGE_TRANSPORT: { kind: 'link', label: 'Arrange transport' },
  REVIEW_TRANSPORT_QUOTES: { kind: 'scroll', target: 'transport-section', label: 'Review transport quotes' },
  START_PICKUP: { kind: 'link', to: '/dashboard/truck-owner', label: 'Open transport job dashboard' },
  MARK_IN_TRANSIT: { kind: 'link', to: '/dashboard/truck-owner', label: 'Open transport job dashboard' },
  MARK_DELIVERED: { kind: 'link', to: '/dashboard/truck-owner', label: 'Open transport job dashboard' },
  CONFIRM_RECEIPT: { kind: 'scroll', target: 'confirm-receipt', label: 'Confirm receipt' },
};

const ACTOR_LABEL = {
  BUYER: 'the buyer',
  SELLER: 'the seller',
  BUYER_OR_SELLER: 'the buyer or seller',
  TRUCK_OWNER: 'the transporter',
  INSPECTOR: 'the inspector',
  ADMIN: 'an administrator',
};

export default function WorkflowActions({ actions, orderId, onScroll, emphasizeFirst = true }) {
  const visible = (actions || []).filter((a) => ACTION_UI[a.code]);

  if (visible.length === 0) return null;

  return (
    <div className="next-action-buttons">
      {visible.map((action, index) => {
        const ui = ACTION_UI[action.code];
        const key = `${action.code}-${action.inspectionRequestId || index}`;
        const primary = emphasizeFirst && index === 0 && action.enabled;
        const btnClass = `btn ${primary ? 'btn-primary' : 'btn-outline'} btn-sm`;

        if (!action.enabled) {
          return (
            <span key={key} className="workflow-action-pending muted">
              {ui.label} — waiting on {ACTOR_LABEL[action.actorRole] || 'the responsible party'}
              {action.reason ? ` (${action.reason})` : ''}
            </span>
          );
        }

        if (ui.kind === 'link') {
          const to = ui.to || `/orders/${orderId}/transport`;
          return (
            <Link key={key} className={btnClass} to={to}>
              {ui.label}
            </Link>
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
  );
}
