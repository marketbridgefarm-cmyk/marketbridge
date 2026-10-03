import React, { useMemo } from 'react';
import './AmountPicker.css';

// ============================================================================
// AMOUNT PICKER — select-only money input for deals
// ============================================================================
// Replaces free-typed <input type="number"> fields in negotiations so that
// users cannot type phone numbers (or any other contact detail) into a price
// box and take the deal off-platform.
//
// The value stays a plain numeric STRING, exactly like the old inputs, so
// existing state and Number(value) call sites keep working unchanged.
//
// Options come from one of two places:
//   • reference given  → a band around it (default 50%–150%) in "nice" steps
//   • no reference     → a fixed price ladder clipped to [min, max]
// ============================================================================

const DEFAULT_LOW = 0.5;
const DEFAULT_HIGH = 1.5;
const MAX_OPTIONS = 80;

// 1, 2, 5 × 10^n at or above the raw step.
function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return mult * pow;
}

// Progressive ladder: fine steps for small amounts, coarser for large ones.
function ladderOptions(min, max) {
  const bands = [
    [0, 1000, 50],
    [1000, 5000, 100],
    [5000, 20000, 500],
    [20000, 100000, 1000],
    [100000, 1000000, 10000],
  ];
  const out = [];
  for (const [from, to, step] of bands) {
    for (let v = from === 0 ? step : from; v <= to; v += step) {
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}

function bandOptions(reference, low, high, min, max) {
  const step = niceStep(reference / 40);
  const lo = Math.max(step, Math.floor((reference * low) / step) * step);
  const hi = Math.ceil((reference * high) / step) * step;
  const out = [];
  for (let v = lo; v <= hi + 1e-9 && out.length < MAX_OPTIONS; v += step) {
    const rounded = Math.round(v * 100) / 100;
    if (rounded >= min && rounded <= max) out.push(rounded);
  }
  return out;
}

export function buildAmountOptions({
  reference,
  low = DEFAULT_LOW,
  high = DEFAULT_HIGH,
  min = 0.01,
  max = Infinity,
  current,
}) {
  const ref = Number(reference);
  const base = Number.isFinite(ref) && ref > 0
    ? bandOptions(ref, low, high, min, max)
    : ladderOptions(min, max);

  const set = new Set(base);
  // Always offer the reference itself so "same price" is one tap away.
  if (Number.isFinite(ref) && ref >= min && ref <= max) set.add(ref);
  const cur = Number(current);
  if (current !== '' && Number.isFinite(cur) && cur > 0) set.add(cur);
  return Array.from(set).sort((a, b) => a - b);
}

const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function AmountPicker({
  value,
  onChange,
  reference,
  low,
  high,
  min,
  max,
  disabled = false,
  id,
  className = '',
  ariaLabel = 'Amount in ETB',
  placeholder = 'Select amount (ETB)',
  autoFocus = false,
  required = false,
}) {
  const options = useMemo(
    () => buildAmountOptions({ reference, low, high, min, max, current: value }),
    [reference, low, high, min, max, value]
  );

  const current = value === '' || value == null ? null : Number(value);
  const idx = current == null ? -1 : options.findIndex((o) => o === current);

  const emit = (n) => onChange(n == null ? '' : String(n));

  const stepBy = (dir) => {
    if (disabled || !options.length) return;
    if (idx === -1) {
      // Nothing chosen yet: start at the reference (or the lowest option).
      const ref = Number(reference);
      const start = options.find((o) => o === ref) ?? options[0];
      return emit(start);
    }
    const next = options[idx + dir];
    if (next != null) emit(next);
  };

  return (
    <div className={`amount-picker ${className}`.trim()}>
      <button
        type="button"
        className="amount-picker-step"
        aria-label="Decrease amount"
        disabled={disabled || idx <= 0}
        onClick={() => stepBy(-1)}
      >
        −
      </button>
      <select
        id={id}
        className="amount-picker-select"
        aria-label={ariaLabel}
        value={idx === -1 ? '' : String(current)}
        disabled={disabled}
        required={required}
        autoFocus={autoFocus}
        onChange={(e) => emit(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {fmt(o)} ETB
          </option>
        ))}
      </select>
      <button
        type="button"
        className="amount-picker-step"
        aria-label="Increase amount"
        disabled={disabled || (idx !== -1 && idx >= options.length - 1)}
        onClick={() => stepBy(1)}
      >
        +
      </button>
    </div>
  );
}
