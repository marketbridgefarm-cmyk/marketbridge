import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

function recordEvent(id, eventType) {
  return api.post(`/ads/${id}/events`, { eventType }).catch(() => undefined);
}

// A destinationUrl only counts as a safe internal route if it starts with
// a single "/" and contains no backslashes. Browsers normalize "\" to "/"
// in URLs, so a value like "/\evil.com" or "//evil.com" would pass a bare
// startsWith('/') check yet still resolve to an external or
// protocol-relative origin — the open-redirect bypass patched in
// GHSA-wrjc-x8rr-h8h6. Advertiser-supplied destinationUrl values are
// untrusted, so reject anything that isn't unambiguously internal and let
// it fall through to the external <a> path instead.
function isSafeInternalPath(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.includes('\\')) return false;
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  return true;
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
  const headline = ad.headline || 'Discover more on MarketBridge';
  const image = <img src={ad.creativeImageUrl} alt={headline || 'MarketBridge advertisement'} />;
  const sponsored = <span className="ad-banner-tag">Sponsored</span>;

  if (template === 'BOLD') {
    return <div className="ad-banner ad-banner--bold">{image}<div className="ad-banner-bold-overlay">{sponsored}<strong>{headline}</strong></div></div>;
  }
  if (template === 'MINIMAL') {
    return <div className="ad-banner ad-banner--minimal">{image}<div className="ad-banner-minimal-caption"><span className="ad-banner-tag ad-banner-tag--outline">Sponsored</span><span>{headline}</span></div></div>;
  }
  if (template === 'CARD') {
    return <div className="ad-banner ad-banner--card"><span className="ad-banner-ribbon">Sponsored</span>{image}<div className="ad-banner-card-copy"><strong>{headline}</strong></div></div>;
  }
  if (template === 'SPLIT') {
    return <div className="ad-banner ad-banner--split"><div className="ad-banner-split-image">{image}</div><div className="ad-banner-split-copy">{sponsored}<strong>{headline}</strong><span>Shop, sell and grow with MarketBridge.</span></div></div>;
  }
  if (template === 'EDITORIAL') {
    return <div className="ad-banner ad-banner--editorial">{image}<div className="ad-banner-editorial-copy">{sponsored}<strong>{headline}</strong><span>MarketBridge • Agriculture • Trade</span></div></div>;
  }
  if (template === 'FRESH') {
    return <div className="ad-banner ad-banner--fresh">{image}<div className="ad-banner-fresh-overlay"><span className="ad-banner-fresh-badge">🌿 FARM FRESH</span><strong>{headline}</strong><span>Fresh opportunities. Better markets.</span></div></div>;
  }
  if (template === 'DARK_LUXE') {
    return <div className="ad-banner ad-banner--dark-luxe">{image}<div className="ad-banner-luxe-copy">{sponsored}<strong>{headline}</strong><span>Premium MarketBridge placement</span></div></div>;
  }
  if (template === 'MARKET') {
    return <div className="ad-banner ad-banner--market">{image}<div className="ad-banner-market-copy"><span className="ad-banner-market-badge">MARKETBRIDGE</span><strong>{headline}</strong><span>Explore today's opportunity</span></div></div>;
  }
  if (template === 'GRADIENT') {
    return <div className="ad-banner ad-banner--gradient">{image}<div className="ad-banner-gradient-copy">{sponsored}<strong>{headline}</strong></div></div>;
  }

  return <div className="ad-banner ad-banner--classic" role="region" aria-label="Advertisement">{image}<div className="ad-banner-copy"><strong>{headline}</strong><span>Sponsored</span></div></div>;
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

  // Internal paths are handled by <Link>, which already does client-side
  // navigation on click — forcing window.location.assign on top of that
  // triggered a full-page reload racing the SPA navigation and threw away
  // app state. Only the external-link path (plain <a>, which we've
  // preventDefault()-ed) needs to navigate manually.
  function handleInternalClick() {
    void recordEvent(ad.id, 'CLICK');
  }

  function handleExternalClick() {
    void recordEvent(ad.id, 'CLICK');
    if (!ad.destinationUrl) return;
    window.location.assign(ad.destinationUrl);
  }

  const content = <BannerContent ad={ad} />;

  if (ad.destinationUrl) {
    if (isSafeInternalPath(ad.destinationUrl)) {
      return <Link to={ad.destinationUrl} onClick={handleInternalClick} style={{ textDecoration: 'none' }}>{content}</Link>;
    }
    return <a href={ad.destinationUrl} onClick={(e) => { e.preventDefault(); handleExternalClick(); }} rel="noopener noreferrer">{content}</a>;
  }

  return content;
}
