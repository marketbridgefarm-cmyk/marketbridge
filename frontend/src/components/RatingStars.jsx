import React, { useState } from 'react';

// Renders 5 stars. Read-only by default (pass `value`, a 0-5 number,
// fractional allowed for averages like 4.3). Pass `interactive` + `onChange`
// to turn it into a picker (used by RatingBox's submission form).
export default function RatingStars({ value = 0, interactive = false, onChange, size = 18 }) {
  const [hover, setHover] = useState(0);
  const display = interactive && hover ? hover : value;

  return (
    <span className={`rating-stars${interactive ? ' rating-stars-interactive' : ''}`} role={interactive ? 'radiogroup' : 'img'} aria-label={interactive ? 'Rate from 1 to 5 stars' : `Rated ${value.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= Math.round(display);
        const Star = (
          <svg key={n} width={size} height={size} viewBox="0 0 20 20" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4">
            <path d="M10 1.6l2.47 5.24 5.63.63-4.2 3.9 1.12 5.63L10 14.9l-5.02 2.1 1.12-5.63-4.2-3.9 5.63-.63L10 1.6z" strokeLinejoin="round" />
          </svg>
        );
        if (!interactive) return Star;
        return (
          <button
            type="button"
            key={n}
            className="rating-star-btn"
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            aria-checked={value === n}
            role="radio"
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onFocus={() => setHover(n)}
            onBlur={() => setHover(0)}
            onClick={() => onChange?.(n)}
          >
            {Star}
          </button>
        );
      })}
    </span>
  );
}
