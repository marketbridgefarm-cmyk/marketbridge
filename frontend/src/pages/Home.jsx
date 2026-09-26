import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdvertisementBanner from '../components/AdvertisementBanner.jsx';
import api from '../api/client';
import '../mb-home.css';

const pillars = [
  ['Agricultural marketplace', 'Connect farmers, agricultural producers, investors and buyers for farm-produced goods, including bulk and time-sensitive harvests.'],
  ['Physical products', 'Buy and sell general physical products through independent sellers and buyers without MarketBridge owning the merchandise.'],
  ['Digital marketplace', 'Discover and sell eBooks, courses, software, documents, templates, graphics, photos and other digital products.'],
];

const marketplaceCards = [
  {
    label: 'Agriculture',
    title: 'Agricultural',
    description: 'A specialized marketplace for farm-produced goods, bulk lots and time-sensitive harvests.',
    features: ['Farmers & producers', 'Bulk agricultural lots', 'Offers & negotiation', 'Inspection & evidence', 'Transport arrangement'],
    link: '/agricultural',
    button: 'Enter Agricultural Marketplace',
    tone: 'green',
  },
  {
    label: 'Physical commerce',
    title: 'Products',
    description: 'A broader marketplace connecting independent sellers with buyers looking for physical products.',
    features: ['Physical products', 'Independent sellers', 'Buyer discovery', 'Orders & records', 'Delivery options'],
    link: '/products',
    button: 'Browse Physical Products',
    tone: 'gold',
  },
  {
    label: 'Digital commerce',
    title: 'Digital',
    description: 'A marketplace for independently supplied digital products and downloadable resources.',
    features: ['eBooks', 'Courses', 'Software', 'Documents & templates', 'Graphics & photos'],
    link: '/digital',
    button: 'Browse Digital Products',
    tone: 'blue',
  },
];

const journey = [
  ['Seller / Farmer lists', 'Products become available to buyers.'],
  ['Buyer discovers', 'Find available products and agricultural lots.'],
  ['Inspection / evidence', 'Quality information can support the transaction.'],
  ['Offer / negotiation', 'Buyers and sellers can negotiate where supported.'],
  ['Order & payment', 'The transaction moves into the order workflow.'],
  ['Own truck / hire transport', 'Delivery can use available transport options.'],
  ['Delivery', 'The product moves to the buyer.'],
  ['Buyer confirms receipt', 'The marketplace transaction reaches confirmation.'],
];

const trustItems = [
  ['Independent sellers', 'Direct marketplace participation', <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>],
  ['Offers & negotiation', 'Agree on the right deal', <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 10h8"/><path d="M8 14h5"/></>],
  ['Marketplace records', 'Clear transaction history', <><path d="M12 3 20 7v5c0 4.8-3.1 7.8-8 9-4.9-1.2-8-4.2-8-9V7z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>],
  ['Buyer & seller accounts', 'Built for both sides of trade', <><path d="M16 11a4 4 0 1 0-8 0"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M18 8a3 3 0 1 0-2.5-4.5"/><path d="M20 21a6 6 0 0 0-3.5-5.5"/></>],
];

const showcaseTabs = [
  ['agricultural', 'Agricultural', '/agricultural', 'green'],
  ['products', 'Products', '/products', 'gold'],
  ['digital', 'Digital', '/digital', 'blue'],
];

// Normalises each marketplace response into one card shape.
const showcaseSources = {
  agricultural: ['/listings', { category: 'AGRICULTURAL' }, (d) => (d?.listings || []).map((l) => ({
    id: l.id, title: l.title || l.cropType || 'Listing', meta: l.location, price: l.askingPrice, image: l.photos?.[0], to: `/listings/${l.id}`,
  }))],
  products: ['/listings', { category: 'PRODUCT' }, (d) => (d?.listings || []).map((l) => ({
    id: l.id, title: l.title || 'Product', meta: l.location, price: l.askingPrice, image: l.photos?.[0], to: `/listings/${l.id}`,
  }))],
  digital: ['/digital-products', {}, (d) => (d?.products || []).map((p) => ({
    id: p.id, title: p.title, meta: (p.productType || '').replaceAll('_', ' '), price: p.price, image: p.previewImageUrl || null, to: '/digital',
  }))],
};

function formatStat(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function HeroMarketplaceStats({ stats, loading }) {
  const items = [
    ['activeListings', 'Active listings'],
    ['activeUsers', 'Marketplace users'],
    ['completedOrders', 'Completed orders'],
    ['agriculturalLots', 'Agricultural lots'],
  ];

  return (
    <aside className={`hero-stat-card${loading ? ' hero-stat-loading' : ''}`} aria-label="Live MarketBridge marketplace statistics">
      <div className="hero-stat-header">
        <span className="hero-stat-label">Marketplace today</span>
        <span className="hero-stat-live">Live statistics</span>
      </div>

      <div className="hero-stat-grid">
        {items.map(([key, label]) => (
          <div className="hero-stat" key={key}>
            <strong>{formatStat(stats?.[key])}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="hero-stat-footer">
        <span>{stats?.updatedAt ? `Updated ${new Date(stats.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Connecting to marketplace data'}</span>
        <span className="hero-stat-refresh">Refreshes every 60s</span>
      </div>
    </aside>
  );
}

function ShowcaseTile({ item, tone, fallbackLabel, to }) {
  const content = (
    <>
      <div className="showcase-media">
        {item?.image ? <img src={item.image} alt={item.title} loading="lazy" decoding="async" /> : <span aria-hidden="true">{(item?.title || fallbackLabel).slice(0, 2)}</span>}
      </div>
      <div className="showcase-caption">
        <strong>{item ? item.title : 'Your listing here'}</strong>
        <span>
          {item
            ? `${item.meta ? item.meta + ' · ' : ''}${Number(item.price || 0).toLocaleString()} ETB`
            : 'List it and buyers can find it'}
        </span>
      </div>
    </>
  );
  return <Link className={`showcase-tile ${tone}${item ? '' : ' is-empty'}`} to={item?.to || to}>{content}</Link>;
}

function Showcase() {
  const [active, setActive] = useState('agricultural');
  const [items, setItems] = useState({});

  useEffect(() => {
    let cancelled = false;
    Object.entries(showcaseSources).forEach(async ([key, [url, params, normalise]]) => {
      try {
        const { data } = await api.get(url, { params });
        if (!cancelled) setItems((prev) => ({ ...prev, [key]: normalise(data).slice(0, 6) }));
      } catch {
        if (!cancelled) setItems((prev) => ({ ...prev, [key]: [] }));
      }
    });
    return () => { cancelled = true; };
  }, []);

  const [, label, route, tone] = showcaseTabs.find(([key]) => key === active);
  const current = items[active] || [];
  const tiles = Array.from({ length: 6 }, (_, i) => current[i] || null);

  return (
    <div className="showcase">
      <div className="showcase-tabs" role="tablist" aria-label="Marketplace showcase">
        {showcaseTabs.map(([key, name]) => (
          <button key={key} type="button" role="tab" aria-selected={active === key} className={active === key ? 'is-active' : ''} onClick={() => setActive(key)}>
            {name}
          </button>
        ))}
      </div>
      <div className="showcase-grid" role="tabpanel">
        {tiles.map((item, i) => (
          <ShowcaseTile key={item?.id || `empty-${i}`} item={item} tone={tone} fallbackLabel={label} to={route} />
        ))}
      </div>
      <Link className="showcase-more" to={route}>See all {label.toLowerCase()}</Link>
    </div>
  );
}

function AdSlot({ children, cta }) {
  return (
    <div className="home-container ad-slot">
      {children}
      {cta && <Link className="ad-slot-cta" to="/dashboard/advertiser">Advertise on MarketBridge</Link>}
    </div>
  );
}

function PlatformStep({ number, title, description, link }) {
  return (
    <Link className="platform-step" to={link}>
      <div className="step-number">{number}</div>
      <div className="step-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <span className="step-arrow" aria-hidden="true">→</span>
    </Link>
  );
}

export default function Home() {
  const [marketStats, setMarketStats] = useState(null);
  const [marketStatsLoading, setMarketStatsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadStats = async () => {
      try {
        const response = await api.get('/public/stats', { timeout: 8000 });
        if (!cancelled) setMarketStats(response.data?.stats || null);
      } catch {
        if (!cancelled) setMarketStats(null);
      } finally {
        if (!cancelled) setMarketStatsLoading(false);
      }
    };

    loadStats();
    const interval = window.setInterval(loadStats, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <main className="mb-home">
      <section className="home-hero">
        <div className="home-container hero-grid">
          <div className="hero-content">
            <p className="hero-eyebrow">MarketBridge platform</p>

            <h1 className="hero-title">
              One marketplace.
              <span>Three ways to trade.</span>
            </h1>

            <p className="hero-description">
              MarketBridge connects farmers, producers, sellers, buyers,
              investors and independent service providers through one
              marketplace platform for agricultural, physical and digital
              commerce.
            </p>

            <div className="hero-join">
              <strong>New to MarketBridge?</strong>
              <span>
                Create an account to buy, sell, negotiate and participate
                across the marketplace.
              </span>

              <div className="account-actions">
                <Link className="home-btn home-btn-primary" to="/register">
                  Join MarketBridge
                </Link>
                <Link className="home-btn home-btn-light" to="/login">
                  Sign in
                </Link>
              </div>
            </div>
          </div>

          <div className="hero-visual">
            <HeroMarketplaceStats stats={marketStats} loading={marketStatsLoading} />

            <div className="platform-card">
              <div className="platform-header">
                <span className="platform-label">Choose a marketplace</span>
                <span className="platform-status">Connected</span>
              </div>

              <div className="platform-main">
                <strong>A marketplace built around people.</strong>
                <p>
                  Independent producers and sellers keep ownership of their
                  goods while MarketBridge provides marketplace infrastructure.
                </p>
              </div>

              <div className="platform-flow">
                <PlatformStep number="01" title="Agricultural" description="Farm produce, offers, inspection & transport" link="/agricultural" />
                <PlatformStep number="02" title="Products" description="Independent physical product sellers" link="/products" />
                <PlatformStep number="03" title="Digital" description="eBooks, courses, software & creative products" link="/digital" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="trust-carousel" aria-label="MarketBridge marketplace features">
        <div className="trust-carousel-track">
          {[0, 1].map((copy) =>
            trustItems.map(([title, subtitle, icon]) => (
              <span className="trust-item" key={`${copy}-${title}`} aria-hidden={copy === 1 ? 'true' : undefined}>
                <span className="trust-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">{icon}</svg>
                </span>
                <span className="trust-copy">
                  <span className="trust-title">{title}</span>
                  <span className="trust-subtitle">{subtitle}</span>
                </span>
              </span>
            ))
          )}
        </div>
      </div>

      <AdSlot>
        <AdvertisementBanner />
      </AdSlot>

      <section className="home-section" id="marketplaces">
        <div className="home-container">
          <div className="section-heading">
            <h2>Three marketplaces. One MarketBridge platform.</h2>
            <p>
              Choose the marketplace that matches what you want to buy or sell,
              while keeping the same underlying marketplace infrastructure.
            </p>
          </div>

          <div className="marketplace-grid">
            {marketplaceCards.map((marketplace) => (
              <article className={`market-card ${marketplace.tone}`} key={marketplace.title}>
                <span className="market-label">{marketplace.label}</span>
                <h3>{marketplace.title}</h3>
                <p>{marketplace.description}</p>
                <ul className="market-list">
                  {marketplace.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <Link className="market-link" to={marketplace.link}>
                  {marketplace.button}
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="home-section" style={{ paddingBottom: 0 }}>
        <div className="home-container">
          <div className="section-heading">
            <h2>Fresh from the marketplace.</h2>
            <p>A look at what independent farmers, sellers and creators have listed right now.</p>
          </div>
          <Showcase />
        </div>
      </section>

      <AdSlot cta>
        <AdvertisementBanner />
      </AdSlot>

      <section className="home-section home-section-alt">
        <div className="home-container">
          <div className="section-heading">
            <h2>MarketBridge facilitates the marketplace.</h2>
            <p>
              The platform brings the participants, communication, records and
              transaction workflow together while independent sellers and
              producers retain responsibility for their goods.
            </p>
          </div>

          <div className="pillar-grid">
            {pillars.map(([title, description]) => (
              <article className="pillar" key={title}>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="home-section">
        <div className="home-container">
          <div className="section-heading">
            <h2>From listing to delivery, in eight steps.</h2>
            <p>
              A structured marketplace journey designed to support real
              transactions from discovery through delivery and confirmation.
            </p>
          </div>

          <ol className="process-grid">
            {journey.map(([title, description], index) => (
              <li className="process-item" key={title}>
                <span className="process-number">{String(index + 1).padStart(2, '0')}</span>
                <strong>{title}</strong>
                <p>{description}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="home-section" style={{ paddingTop: 0 }}>
        <div className="home-container">
          <div className="final-cta">
            <h2>Buy, sell, produce and participate in one platform.</h2>
            <p>
              Choose the marketplace that fits what you want to buy or sell,
              then continue through the marketplace workflow built around
              independent participants.
            </p>

            <div className="final-actions">
              <Link className="home-btn home-btn-primary" to="/register">Create account</Link>
              <Link className="home-btn home-btn-light" to="/agricultural">Agricultural</Link>
              <Link className="home-btn home-btn-light" to="/products">Products</Link>
              <Link className="home-btn home-btn-light" to="/digital">Digital</Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
