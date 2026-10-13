/* Listings map — uses the canonical MarketBridge tokens (mb-tokens.css). */
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './ListingsMap.css';

const DEFAULT_CENTER = [39.5, -98.35]; // continental US
const DEFAULT_ZOOM = 4;

/** Teardrop pin built as a Leaflet divIcon so it inherits our tokens. */
const pinIcon = L.divIcon({
  className: 'lm-pin-wrap',
  html: '<span class="lm-pin" aria-hidden="true"></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -30],
});

function popupHtml(listing) {
  const title = listing.title ?? 'Listing';
  const place = listing.location ?? listing.address ?? '';
  const price = listing.price != null ? `$${Number(listing.price).toLocaleString()}` : '';
  return `
    <div class="lm-popup">
      <strong>${title}</strong>
      ${place ? `<span class="lm-muted">${place}</span>` : ''}
      ${price ? `<span class="lm-muted">${price}</span>` : ''}
      <button type="button" class="lm-open" data-listing-id="${listing.id}">Open listing</button>
    </div>
  `;
}

export default function ListingsMap({
  listings = [],
  onSelect,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  note,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const [view, setView] = useState('map'); // 'list' | 'map'

  // Initialise the Leaflet map once.
  useEffect(() => {
    if (view !== 'map' || mapRef.current || !containerRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [view, center, zoom]);

  // Sync markers whenever the listing set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const points = listings.filter(
      (l) => Number.isFinite(l.lat) && Number.isFinite(l.lng),
    );

    points.forEach((listing) => {
      const marker = L.marker([listing.lat, listing.lng], {
        icon: pinIcon,
        title: listing.title ?? 'Listing',
        alt: listing.title ?? 'Listing',
      })
        .addTo(map)
        .bindPopup(popupHtml(listing));

      marker.on('popupopen', (e) => {
        const btn = e.popup.getElement()?.querySelector('.lm-open');
        if (btn) {
          btn.addEventListener('click', () => onSelect?.(listing), { once: true });
        }
      });

      markersRef.current.push(marker);
    });

    if (points.length > 1) {
      map.fitBounds(
        L.latLngBounds(points.map((p) => [p.lat, p.lng])),
        { padding: [32, 32] },
      );
    } else if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 12);
    }
  }, [listings, onSelect]);

  return (
    <section className="lm" aria-label="Listings map">
      <div className="lm-toggle" role="group" aria-label="View mode">
        <button
          type="button"
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
        >
          List
        </button>
        <button
          type="button"
          aria-pressed={view === 'map'}
          onClick={() => setView('map')}
        >
          Map
        </button>
      </div>

      {view === 'map' && <div ref={containerRef} className="lm-canvas" />}

      {view === 'list' && (
        <ul className="lm-list">
          {listings.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                className="lm-open"
                onClick={() => onSelect?.(l)}
              >
                {l.title ?? 'Listing'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {note && <p className="lm-note">{note}</p>}
    </section>
  );
}
