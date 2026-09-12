import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

function recordEvent(id, eventType) {
  return api.post(`/ads/${id}/events`, { eventType }).catch(() => undefined);
}

// Picks one banner at random per mount from all currently active BANNER
// campaigns, so paying advertisers rotate fairly across page loads instead
// of the same first-found campaign always winning the slot.
function pickRandomBanner(ads) {
  const banners = (ads || []).filter((item) => item.type === 'BANNER' && item.creativeImageUrl);
  if (!banners.length) return null;
  return banners[Math.floor(Math.random() * banners.length)];
}

// Each advertiser picks one of these layouts (BANNER_TEMPLATE_OPTIONS in
// AdvertiserDashboard.jsx) when creating a campaign. Unknown/legacy values
// fall back to classic.
function BannerContent({ ad }) {
  const template = ad.bannerTemplate || 'CLASSIC';

  if (template === 'BOLD') {
    return (
      <div className="ad-banner ad-banner--bold">
        <img src={ad.creativeImageUrl} alt={ad.headline || 'MarketBridge advertisement'} />
        <div className="ad-banner-bold-overlay">
          <span className="ad-banner-tag">Sponsored</span>
          {ad.headline && <strong>{ad.headline}</strong>}
        </div>
      </div>
    );
  }

  if (template === 'MINIMAL') {
    return (
      <div className="ad-banner ad-banner--minimal">
        <img src={ad.creativeImageUrl} alt={ad.headline || 'MarketBridge advertisement'} />
        <div className="ad-banner-minimal-caption">
          <span className="ad-banner-tag ad-banner-tag--outline">Sponsored</span>
          {ad.headline && <span>{ad.headline}</span>}
        </div>
      </div>
    );
  }

  if (template === 'CARD') {
    return (
      <div className="ad-banner ad-banner--card">
        <span className="ad-banner-ribbon">Sponsored</span>
        <img src={ad.creativeImageUrl} alt={ad.headline || 'MarketBridge advertisement'} />
        {ad.headline && <div className="ad-banner-card-copy"><strong>{ad.headline}</strong></div>}
      </div>
    );
  }

  // CLASSIC (default / legacy campaigns with no template set)
  return (
    <div className="ad-banner ad-banner--classic" role="region" aria-label="Advertisement">
      <img src={ad.creativeImageUrl} alt={ad.headline || 'MarketBridge advertisement'} />
      {ad.headline && <div className="ad-banner-copy"><strong>{ad.headline}</strong><span>Sponsored</span></div>}
    </div>
  );
}

export default function AdvertisementBanner() {
  const [ad, setAd] = useState(null);
  const impressionRecorded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/ads/active')
      .then(({ data }) => {
        const banner = pickRandomBanner(data?.ads);
        if (!cancelled) setAd(banner);
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

  const content = <BannerContent ad={ad} />;

  if (ad.destinationUrl) {
    if (ad.destinationUrl.startsWith('/')) {
      return <Link to={ad.destinationUrl} onClick={handleClick} style={{ textDecoration: 'none' }}>{content}</Link>;
    }
    return <a href={ad.destinationUrl} onClick={(e) => { e.preventDefault(); handleClick(); }} rel="noopener noreferrer">{content}</a>;
  }

  return content;
}
