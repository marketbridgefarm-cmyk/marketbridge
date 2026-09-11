import React from 'react';
import { Link } from 'react-router-dom';

// Renders a short "what's changed since you were last here" strip.
// Every dashboard builds its own `items` array from data it has already
// fetched (no extra API calls) and hands it to this component, so the
// look/behavior of "recent activity" stays identical everywhere.
//
// item shape: { id, icon, text, time (Date|string|number), href? }

function timeAgo(time) {
  if (!time) return '';
  const date = time instanceof Date ? time : new Date(time);
  if (Number.isNaN(date.getTime())) return '';

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  return date.toLocaleDateString();
}

export default function RecentActivity({ items = [], emptyText = "You're all caught up — nothing new since your last visit." }) {
  const sorted = [...items]
    .filter(Boolean)
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, 5);

  return (
    <div className="recent-activity">
      <div className="recent-activity-head">
        <span className="sd-eyebrow">SINCE YOU WERE LAST HERE</span>
      </div>

      {sorted.length === 0 ? (
        <p className="sd-muted recent-activity-empty">{emptyText}</p>
      ) : (
        <ul className="recent-activity-list">
          {sorted.map((item) => {
            const row = (
              <>
                <span className="recent-activity-icon" aria-hidden="true">{item.icon || '•'}</span>
                <span className="recent-activity-text">{item.text}</span>
                <span className="recent-activity-time">{timeAgo(item.time)}</span>
              </>
            );
            return (
              <li key={item.id} className="recent-activity-row">
                {item.href ? (
                  <Link to={item.href} className="recent-activity-link">{row}</Link>
                ) : (
                  <div className="recent-activity-link">{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
