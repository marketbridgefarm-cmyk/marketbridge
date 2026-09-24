import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Descriptive placeholder for "nothing here yet" / "no matches" states.
 * actionTo renders a Link, onAction renders a button — pass at most one.
 */
export default function EmptyState({ icon = '🌾', title, description, actionLabel, actionTo, onAction }) {
  return (
    <div className="mb-empty-state">
      <span className="mb-empty-state-icon" aria-hidden="true">{icon}</span>
      <h3>{title}</h3>
      {description && <p className="muted">{description}</p>}
      {actionLabel && actionTo && (
        <Link className="btn btn-light" to={actionTo}>{actionLabel}</Link>
      )}
      {actionLabel && onAction && !actionTo && (
        <button type="button" className="btn btn-light" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}
