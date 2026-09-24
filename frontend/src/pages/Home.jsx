import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdvertisementBanner from '../components/AdvertisementBanner.jsx';
import api from '../api/client';

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

const HOME_PAGE_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Figtree:wght@400;500;600;700&display=swap');

  .mb-home {
    --ink: #0b2217;
    --forest: #123524;
    --field: #1c7c4f;
    --leaf: #86d9a5;
    --wheat: #dba63f;
    --sky: #3556c9;
    --paper: #f3f6f1;
    --muted: #55655b;
    --line: rgba(11, 34, 23, .16);
    --display: 'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif;
    --body: 'Figtree', 'Segoe UI', system-ui, sans-serif;
    font-family: var(--body);
    color: var(--ink);
    background: var(--paper);
    overflow: hidden;
  }
  .mb-home *, .mb-home *::before, .mb-home *::after { box-sizing: border-box; }
  .mb-home a:focus-visible { outline: 3px solid var(--wheat); outline-offset: 3px; }
  .mb-home h1, .mb-home h2, .mb-home h3 { font-family: var(--display); margin: 0; }
  .mb-home .home-container { width: min(1200px, calc(100% - 40px)); margin: 0 auto; }

  /* Hero: crop rows on deep green */
  .mb-home .home-hero {
    color: #f2f8f3;
    background:
      repeating-linear-gradient(100deg, transparent 0 54px, rgba(134,217,165,.06) 54px 55px),
      radial-gradient(ellipse at 85% 0%, rgba(28,124,79,.55), transparent 55%),
      var(--ink);
  }
  .mb-home .hero-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr);
    gap: clamp(36px, 6vw, 88px);
    align-items: center;
    padding: 96px 0 88px;
  }
  .mb-home .hero-content > *, .mb-home .hero-visual > * { animation: mb-rise .8s cubic-bezier(.2,.7,.2,1) both; }
  .mb-home .hero-content > :nth-child(2) { animation-delay: .08s; }
  .mb-home .hero-content > :nth-child(3) { animation-delay: .16s; }
  .mb-home .hero-visual > :nth-child(1) { animation-delay: .2s; }
  .mb-home .hero-visual > :nth-child(2) { animation-delay: .3s; }
  @keyframes mb-rise { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }

  .mb-home .hero-eyebrow {
    margin: 0 0 22px;
    color: var(--leaf);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: .01em;
  }
  .mb-home .hero-title {
    font-size: clamp(46px, 7vw, 92px);
    line-height: .95;
    letter-spacing: -.035em;
    font-weight: 800;
  }
  .mb-home .hero-title span { display: block; color: var(--leaf); }
  .mb-home .hero-description {
    max-width: 56ch;
    margin: 28px 0 0;
    color: rgba(242,248,243,.78);
    font-size: 18px;
    line-height: 1.65;
  }
  .mb-home .hero-join {
    margin-top: 36px;
    padding-top: 28px;
    border-top: 1px solid rgba(242,248,243,.18);
    max-width: 56ch;
  }
  .mb-home .hero-join strong { display: block; font-family: var(--display); font-size: 20px; }
  .mb-home .hero-join > span { display: block; margin-top: 6px; color: rgba(242,248,243,.68); line-height: 1.55; }
  .mb-home .account-actions, .mb-home .final-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }

  .mb-home .home-btn {
    min-height: 50px;
    display: inline-flex;
    align-items: center;
    padding: 12px 22px;
    border-radius: 8px;
    font-weight: 700;
    font-size: 15px;
    text-decoration: none;
    transition: background .2s, border-color .2s;
  }
  .mb-home .home-btn-primary { background: var(--wheat); color: var(--ink); }
  .mb-home .home-btn-primary:hover { background: #ecbb5a; }
  .mb-home .home-btn-light { color: #f2f8f3; border: 1px solid rgba(242,248,243,.35); }
  .mb-home .home-btn-light:hover { border-color: #f2f8f3; background: rgba(242,248,243,.08); }

  /* Live stats: the paper-white ledger card */
  .mb-home .hero-visual { display: grid; gap: 16px; }
  .mb-home .hero-stat-card { background: var(--paper); color: var(--ink); border-radius: 14px; padding: 26px; }
  .mb-home .hero-stat-header, .mb-home .hero-stat-footer { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
  .mb-home .hero-stat-label { font-weight: 700; color: var(--ink); }
  .mb-home .hero-stat-live { display: inline-flex; align-items: center; gap: 7px; }
  .mb-home .hero-stat-live::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--field); }
  .mb-home .hero-stat-grid { display: grid; grid-template-columns: 1fr 1fr; margin: 18px 0; border-block: 1px solid var(--line); }
  .mb-home .hero-stat { padding: 18px 0; }
  .mb-home .hero-stat:nth-child(even) { padding-left: 20px; border-left: 1px solid var(--line); }
  .mb-home .hero-stat:nth-child(n+3) { border-top: 1px solid var(--line); }
  .mb-home .hero-stat strong { display: block; font-family: var(--display); font-size: clamp(34px, 4vw, 48px); line-height: 1; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
  .mb-home .hero-stat span { display: block; margin-top: 6px; font-size: 13px; color: var(--muted); }
  .mb-home .hero-stat-loading strong { opacity: .35; }

  .mb-home .platform-card { border: 1px solid rgba(242,248,243,.2); border-radius: 14px; padding: 22px 8px 8px; background: rgba(242,248,243,.04); }
  .mb-home .platform-header { display: flex; justify-content: space-between; padding: 0 14px; font-size: 13px; color: rgba(242,248,243,.65); }
  .mb-home .platform-label { font-weight: 700; color: #f2f8f3; }
  .mb-home .platform-main { padding: 14px 14px 16px; }
  .mb-home .platform-main small { display: none; }
  .mb-home .platform-main strong { font-family: var(--display); font-size: 22px; line-height: 1.2; }
  .mb-home .platform-main p { margin: 8px 0 0; font-size: 14px; line-height: 1.55; color: rgba(242,248,243,.68); }
  .mb-home .platform-step {
    display: grid; grid-template-columns: 30px 1fr auto; gap: 12px; align-items: center;
    padding: 14px; border-radius: 8px; color: inherit; text-decoration: none;
    border-top: 1px solid rgba(242,248,243,.14);
    transition: background .2s;
  }
  .mb-home .platform-step:hover { background: rgba(242,248,243,.08); }
  .mb-home .step-number { color: var(--wheat); font-family: var(--display); font-weight: 700; }
  .mb-home .step-copy strong { display: block; font-size: 16px; }
  .mb-home .step-copy span { font-size: 13px; color: rgba(242,248,243,.62); }
  .mb-home .step-arrow { color: var(--leaf); }

  /* Trust marquee */
  .mb-home .trust-carousel { background: var(--wheat); color: var(--ink); overflow: hidden; }
  .mb-home .trust-carousel-track { display: flex; width: max-content; animation: mb-marquee 42s linear infinite; }
  .mb-home .trust-carousel:hover .trust-carousel-track { animation-play-state: paused; }
  @keyframes mb-marquee { to { transform: translateX(-50%); } }
  .mb-home .trust-item { display: flex; align-items: center; gap: 12px; padding: 16px 40px; white-space: nowrap; }
  .mb-home .trust-icon svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; display: block; }
  .mb-home .trust-copy { display: flex; flex-direction: column; }
  .mb-home .trust-title { font-weight: 700; font-size: 15px; }
  .mb-home .trust-subtitle { font-size: 13px; opacity: .75; }

  /* Sections */
  .mb-home .home-section { padding: clamp(72px, 9vw, 120px) 0; }
  .mb-home .home-section-alt { background: #e7eee6; }
  .mb-home .section-heading { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 20px 60px; align-items: end; margin-bottom: 52px; }
  .mb-home .section-heading h2 { font-size: clamp(32px, 4.4vw, 56px); line-height: 1.02; letter-spacing: -.03em; font-weight: 800; }
  .mb-home .section-heading p { margin: 0; color: var(--muted); font-size: 17px; line-height: 1.65; max-width: 52ch; }

  /* Marketplaces: three tonal panels, the tone is the card */
  .mb-home .marketplace-grid { display: grid; grid-template-columns: 1.25fr 1fr 1fr; gap: 16px; }
  .mb-home .market-card { display: flex; flex-direction: column; padding: 34px 30px 30px; border-radius: 16px; color: #fff; }
  .mb-home .market-card.green { background: var(--field); }
  .mb-home .market-card.gold { background: var(--wheat); color: var(--ink); }
  .mb-home .market-card.blue { background: var(--sky); }
  .mb-home .market-label { font-size: 14px; font-weight: 600; opacity: .8; }
  .mb-home .market-card h3 { margin-top: 44px; font-size: clamp(38px, 4.6vw, 60px); line-height: .95; letter-spacing: -.035em; font-weight: 800; }
  .mb-home .market-card p { margin: 16px 0 0; line-height: 1.6; opacity: .9; }
  .mb-home .market-list { list-style: none; margin: 26px 0 30px; padding: 0; }
  .mb-home .market-list li { padding: 10px 0; border-top: 1px solid currentColor; border-top-color: rgba(255,255,255,.28); font-weight: 500; }
  .mb-home .market-card.gold .market-list li { border-top-color: rgba(11,34,23,.25); }
  .mb-home .market-link { margin-top: auto; align-self: flex-start; color: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 5px; text-decoration-thickness: 2px; }
  .mb-home .market-link:hover { text-underline-offset: 8px; }

  /* Pillars: plain columns, not cards */
  .mb-home .pillar-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; }
  .mb-home .pillar { padding: 4px 32px 4px 0; }
  .mb-home .pillar + .pillar { padding-left: 32px; border-left: 1px solid var(--line); }
  .mb-home .pillar h3 { font-size: 26px; letter-spacing: -.02em; }
  .mb-home .pillar p { margin: 12px 0 0; color: var(--muted); line-height: 1.65; }

  /* Journey: a real sequence, so it is numbered */
  .mb-home .process-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 44px 28px; counter-reset: step; }
  .mb-home .process-item { position: relative; padding-top: 30px; border-top: 2px solid var(--ink); }
  .mb-home .process-item::before {
    content: ''; position: absolute; top: -7px; left: 0; width: 12px; height: 12px; border-radius: 50%; background: var(--wheat); border: 2px solid var(--ink);
  }
  .mb-home .process-number { display: block; font-family: var(--display); font-weight: 700; color: var(--field); margin-bottom: 8px; font-size: 15px; }
  .mb-home .process-item strong { display: block; font-family: var(--display); font-size: 20px; line-height: 1.2; }
  .mb-home .process-item p { margin: 8px 0 0; color: var(--muted); line-height: 1.55; font-size: 15px; }

  /* Closing */
  .mb-home .final-cta { padding: clamp(40px, 7vw, 80px); border-radius: 20px; color: #f2f8f3; background: repeating-linear-gradient(100deg, transparent 0 54px, rgba(134,217,165,.06) 54px 55px), var(--ink); }
  .mb-home .final-cta h2 { max-width: 16ch; font-size: clamp(36px, 5.4vw, 72px); line-height: .98; letter-spacing: -.035em; font-weight: 800; }
  .mb-home .final-cta p { max-width: 54ch; margin: 22px 0 0; color: rgba(242,248,243,.75); font-size: 17px; line-height: 1.65; }
  .mb-home .final-actions { margin-top: 32px; }

  @media (max-width: 960px) {
    .mb-home .hero-grid, .mb-home .section-heading, .mb-home .marketplace-grid { grid-template-columns: 1fr; }
    .mb-home .hero-grid { padding: 64px 0; }
    .mb-home .process-grid { grid-template-columns: repeat(2, 1fr); }
    .mb-home .pillar-grid { grid-template-columns: 1fr; gap: 28px; }
    .mb-home .pillar, .mb-home .pillar + .pillar { padding: 0; border: 0; }
    .mb-home .market-card h3 { margin-top: 28px; }
  }
  @media (max-width: 520px) {
    .mb-home .process-grid { grid-template-columns: 1fr; }
    .mb-home .home-btn { width: 100%; justify-content: center; }
    .mb-home .trust-item { padding: 14px 26px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .mb-home .hero-content > *, .mb-home .hero-visual > * { animation: none; }
    .mb-home .trust-carousel-track { animation: none; }
    .mb-home .trust-carousel { overflow-x: auto; }
  }
`;

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
      <style>{HOME_PAGE_STYLES}</style>

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

      <AdvertisementBanner />

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
