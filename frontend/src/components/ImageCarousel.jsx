import React, { useCallback, useEffect, useRef, useState } from 'react';

// Distance (px) a horizontal drag must travel before it counts as a swipe.
const SWIPE_THRESHOLD = 40;

/**
 * Swipeable image carousel.
 *
 * Used for Telegram "Photo Carousel" promotions: previewing the album while
 * the advertiser builds it, showing it on their campaign card, and letting
 * MarketBridge staff review the photos they will post.
 *
 * - `images`: array of image URLs, in slide order.
 * - `openLinks`: show an "Open full size" link under each slide (staff use
 *   this to grab the original file when posting by hand).
 * - Works with mouse (buttons/dots), touch (swipe) and keyboard (← / →).
 */
export default function ImageCarousel({ images = [], alt = 'Promotion photo', openLinks = false, className = '' }) {
  const urls = (images || []).filter(Boolean);
  const [index, setIndex] = useState(0);
  const touchStartX = useRef(null);
  const count = urls.length;

  // Keep the visible slide valid when photos are removed or replaced.
  useEffect(() => {
    setIndex((i) => (count === 0 ? 0 : Math.min(i, count - 1)));
  }, [count]);

  const go = useCallback((next) => {
    if (count === 0) return;
    setIndex(((next % count) + count) % count);
  }, [count]);

  function onKeyDown(e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
  }

  function onTouchStart(e) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }

  function onTouchEnd(e) {
    if (touchStartX.current == null) return;
    const delta = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) < SWIPE_THRESHOLD) return;
    go(delta < 0 ? index + 1 : index - 1);
  }

  if (count === 0) return null;

  return (
    <div
      className={`img-carousel ${className}`.trim()}
      role="group"
      aria-roledescription="carousel"
      aria-label={`${count} photo${count === 1 ? '' : 's'}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="img-carousel-viewport" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="img-carousel-track" style={{ transform: `translateX(-${index * 100}%)` }}>
          {urls.map((url, i) => (
            <div
              className="img-carousel-slide"
              key={`${i}-${url}`}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}`}
              aria-hidden={i !== index}
            >
              <img src={url} alt={`${alt} ${i + 1} of ${count}`} loading={i === 0 ? 'eager' : 'lazy'} decoding="async" draggable={false} />
            </div>
          ))}
        </div>

        {count > 1 && (
          <>
            <button type="button" className="img-carousel-btn img-carousel-btn--prev" onClick={() => go(index - 1)} aria-label="Previous photo">‹</button>
            <button type="button" className="img-carousel-btn img-carousel-btn--next" onClick={() => go(index + 1)} aria-label="Next photo">›</button>
            <span className="img-carousel-counter" aria-live="polite">{index + 1} / {count}</span>
          </>
        )}
      </div>

      {count > 1 && (
        <div className="img-carousel-dots">
          {urls.map((url, i) => (
            <button
              type="button"
              key={`${i}-dot`}
              className={`img-carousel-dot${i === index ? ' img-carousel-dot--active' : ''}`}
              onClick={() => go(i)}
              aria-label={`Show photo ${i + 1}`}
              aria-current={i === index ? 'true' : undefined}
            />
          ))}
        </div>
      )}

      {openLinks && (
        <a className="img-carousel-open" href={urls[index]} target="_blank" rel="noopener noreferrer">
          Open photo {index + 1} full size
        </a>
      )}
    </div>
  );
}
