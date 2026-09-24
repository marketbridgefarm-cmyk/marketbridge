import React from 'react';

/**
 * Standard view header: eyebrow label, title, description and an optional
 * action (usually a primary button/link). Presentational only — no data
 * fetching, no business logic.
 */
export default function PageHeader({ eyebrow, title, description, action }) {
  return (
    <div className="page-header mb-page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p className="mb-page-header-desc">{description}</p>}
      </div>
      {action && <div className="mb-page-header-action">{action}</div>}
    </div>
  );
}
