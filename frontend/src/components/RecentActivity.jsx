import React, { useState } from 'react';
import { Link } from 'react-router-dom';

function formatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
}

export default function RecentActivity({ items = [], emptyText = 'No recent activity yet.' }) {
  const [open, setOpen] = useState(false);

  const hasItems = items.length > 0;

  return (
    <div className={`recent-activity ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="recent-activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="recent-activity-title">
          Recent activity
          {hasItems && (
            <span className="recent-activity-title-count">{items.length}</span>
          )}
        </span>
        <svg
          className="recent-activity-chevron"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="recent-activity-body">
        {!hasItems ? (
          <p className="recent-activity-empty muted">{emptyText}</p>
        ) : (
          <ul className="recent-activity-list">
            {items.map((item) => {
              const content = (
                <>
                  <span className="recent-activity-icon" aria-hidden="true">
                    {item.icon || '•'}
                  </span>
                  <span className="recent-activity-text">{item.text}</span>
                  <span className="recent-activity-time">{formatTime(item.time)}</span>
                </>
              );

              return (
                <li className="recent-activity-row" key={item.id}>
                  {item.href ? (
                    <Link to={item.href} className="recent-activity-link">
                      {content}
                    </Link>
                  ) : (
                    <div className="recent-activity-link">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
