import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './ListingsMap.css';   // shares the orange pin style
import './LocationPicker.css';

const DEFAULT_CENTER = [9.03, 38.74]; // Addis Ababa, only used when no pin is set
const DEFAULT_ZOOM = 6;
const PIN_ZOOM = 13;

const parse = (v) => (v === '' || v == null ? NaN : Number(v));
const fmt = (n) => String(Math.round(n * 1e6) / 1e6);

function pinIcon() {
  return L.divIcon({
    className: 'lm-pin-wrap',
    html: '<span class="lm-pin"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}


/**
 * Tap the map to drop a pin, or drag the pin to adjust it.
 * props: latitude, longitude (strings, '' when unset), onChange({ latitude, longitude })
 */
export default function LocationPicker({ latitude, longitude, onChange }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const placeRef = useRef(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Create the map once.
  useEffect(() => {
    const lat = parse(latitude);
    const lng = parse(longitude);
    const has = Number.isFinite(lat) && Number.isFinite(lng);

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const map = L.map(containerRef.current, {
      center: has ? [lat, lng] : DEFAULT_CENTER,
      zoom: has ? PIN_ZOOM : DEFAULT_ZOOM,
      scrollWheelZoom: false,
      fadeAnimation: !reduceMotion,
      zoomAnimation: !reduceMotion,
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(map);

    const emit = (p) =>
      onChangeRef.current({ latitude: fmt(p.lat), longitude: fmt(p.lng) });

    const place = (latlng) => {
      if (!markerRef.current) {
        const marker = L.marker(latlng, {
          icon: pinIcon(),
          draggable: true,
          keyboard: true,
          title: 'Listing location. Drag to adjust.',
        }).addTo(map);
        marker.on('dragend', () => emit(marker.getLatLng()));
        markerRef.current = marker;
      } else {
        markerRef.current.setLatLng(latlng);
      }
    };
    placeRef.current = place;

    map.on('click', (e) => {
      place(e.latlng);
      emit(e.latlng);
    });

    if (has) place([lat, lng]);
    mapRef.current = map;

    // The picker often opens inside a sheet that is still sizing itself.
    const t = setTimeout(() => map.invalidateSize(), 250);

    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      placeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow changes made elsewhere (e.g. "Use my current location", "Clear pin").
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const lat = parse(latitude);
    const lng = parse(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    const current = markerRef.current && markerRef.current.getLatLng();
    const moved =
      !current ||
      Math.abs(current.lat - lat) > 1e-5 ||
      Math.abs(current.lng - lng) > 1e-5;

    if (moved) {
      placeRef.current([lat, lng]);
      map.setView([lat, lng], Math.max(map.getZoom(), PIN_ZOOM));
    }
  }, [latitude, longitude]);

  return (
    <div className="lp">
      <div ref={containerRef} className="lp-canvas" role="region" aria-label="Map for choosing the listing location" />
      <p className="lp-hint">Tap the map to place the pin. Drag the pin to adjust it.</p>
    </div>
  );
}
