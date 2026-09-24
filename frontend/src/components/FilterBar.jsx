import React, { useEffect, useRef, useState } from 'react';

/**
 * Horizontally scrollable chip row, with an optional debounced search input
 * and an optional "more filters" toggle. Purely presentational — the parent
 * owns all filter state and search logic; this only calls back.
 *
 * Props:
 *  - chips: [{ value, label }]
 *  - activeValue: currently selected chip value ('' = none/all)
 *  - onSelectChip(value)
 *  - searchValue, onSearchChange(value), searchPlaceholder
 *  - searchDebounceMs (default 350)
 *  - moreLabel, moreActive, onToggleMore — renders a trailing toggle chip
 */
export default function FilterBar({
  chips = [],
  activeValue = '',
  onSelectChip,
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search…',
  searchDebounceMs = 350,
  moreLabel,
  moreActive = false,
  onToggleMore,
}) {
  const [localSearch, setLocalSearch] = useState(searchValue ?? '');
  const debounceRef = useRef(null);

  useEffect(() => {
    setLocalSearch(searchValue ?? '');
  }, [searchValue]);

  function handleSearchInput(e) {
    const value = e.target.value;
    setLocalSearch(value);
    if (!onSearchChange) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchChange(value), searchDebounceMs);
  }

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  return (
    <div className="mb-filter-bar">
      {onSearchChange && (
        <input
          className="mb-filter-bar-search"
          type="search"
          value={localSearch}
          onChange={handleSearchInput}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
      )}
      <div className="mb-filter-bar-chips" role="group" aria-label="Quick filters">
        {chips.map((chip) => (
          <button
            key={chip.value}
            type="button"
            className={`mb-chip${activeValue === chip.value ? ' mb-chip--active' : ''}`}
            onClick={() => onSelectChip?.(chip.value)}
          >
            {chip.label}
          </button>
        ))}
        {moreLabel && (
          <button
            type="button"
            className={`mb-chip mb-chip--more${moreActive ? ' mb-chip--active' : ''}`}
            onClick={onToggleMore}
            aria-expanded={moreActive}
          >
            {moreLabel}
          </button>
        )}
      </div>
    </div>
  );
}
