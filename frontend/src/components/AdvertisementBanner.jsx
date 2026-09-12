import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

function recordEvent(id, eventType) {
  return api.post(`/ads/${id}/events`, { eventType }).catch(() => undefined);
}

export default function AdvertisementBanner() {
  const [ad, setAd] = useState(null);
  const impressionRecorded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/ads/active')
      .then(({ data }) => {
        const banner = (data?.ads || []).find((item) => item.type === 'BANNER');
        if (!cancelled) setAd(banner || null);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ad?.id || impressionRecorded.current) return;
    impressionRecorded.current = true;
    recordEvent(ad.id, 'IMPRESSION');
  }, [ad]);

  if (!ad?.creativeImageUrl) return null;

  function handleClick() {
    void recordEvent(ad.id, 'CLICK');
    if (!ad.destinationUrl) return;
    window.location.assign(ad.destinationUrl);
  }

  const content = (
    <div className="ad-banner" role="region" aria-label="Advertisement">
      <img src={ad.creativeImageUrl} alt={ad.headline || 'MarketBridge advertisement'} />
      {ad.headline && <div className="ad-banner-copy"><strong>{ad.headline}</strong><span>Sponsored</span></div>}
    </div>
  );

  if (ad.destinationUrl) {
    if (ad.destinationUrl.startsWith('/')) {
      return <Link to={ad.destinationUrl} onClick={handleClick} style={{ textDecoration: 'none' }}>{content}</Link>;
    }
    return <a href={ad.destinationUrl} onClick={(e) => { e.preventDefault(); handleClick(); }} rel="noopener noreferrer">{content}</a>;
  }

  return content;
}
