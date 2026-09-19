import React from 'react';
import { Link } from 'react-router-dom';
import AdvertisementBanner from '../components/AdvertisementBanner.jsx';

const pillars = [
  ['01', 'Agricultural marketplace', 'Connect farmers, agricultural producers, investors and buyers for farm-produced goods, including bulk and time-sensitive harvests.'],
  ['02', 'Physical products', 'Buy and sell general physical products through independent sellers and buyers without MarketBridge owning the merchandise.'],
  ['03', 'Digital marketplace', 'Discover and sell eBooks, courses, software, documents, templates, graphics, photos and other digital products.'],
];

const HOME_PAGE_STYLES = `
  .home-page .hero {
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--mb-border, var(--line));
    background: linear-gradient(135deg, #eef6ef 0%, #fbfcfa 58%, #e9f1e9 100%);
    padding: clamp(40px, 8vw, 84px) 0 clamp(36px, 7vw, 74px);
  }
  .home-page .hero::before,
  .home-page .hero::after {
    content: '';
    position: absolute;
    pointer-events: none;
    border-radius: 999px;
    filter: blur(1px);
  }
  .home-page .hero::before {
    width: 340px;
    height: 340px;
    right: -130px;
    top: -160px;
    background: rgba(47, 145, 89, .08);
  }
  .home-page .hero::after {
    width: 260px;
    height: 260px;
    left: -140px;
    bottom: -180px;
    background: rgba(183, 123, 27, .045);
  }
  .home-page .hero > * {
    position: relative;
    z-index: 1;
  }
  .home-page .hero-grid {
    display: grid;
    grid-template-columns: 1.12fr .88fr;
    gap: clamp(28px, 6vw, 70px);
    align-items: center;
  }
  .home-page .hero h1 {
    max-width: 720px;
    letter-spacing: -1.4px;
  }
  .home-page .hero h1 em {
    color: var(--green);
    font-style: normal;
  }
  .home-page .hero-copy {
    font-size: 18px;
    color: #526057;
    max-width: 680px;
  }
  .home-page .hero-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin: 27px 0 18px;
  }
  .home-page .hero-account-cta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 0 0 24px;
    padding: 14px 16px;
    background: rgba(255, 255, 255, .78);
    border: 1px solid rgba(30, 108, 67, .16);
    border-radius: 16px;
    box-shadow: 0 10px 28px rgba(30, 64, 45, .07);
  }
  .home-page .hero-account-copy {
    display: grid;
    gap: 3px;
    min-width: 0;
  }
  .home-page .hero-account-copy strong {
    color: #173b2a;
    font-size: 14px;
  }
  .home-page .hero-account-copy span {
    color: #5a675f;
    font-size: 12px;
    line-height: 1.45;
  }
  .home-page .hero-account-actions {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
  }
  .home-page .hero-account-actions .btn {
    min-height: 42px;
    padding: 9px 14px;
    font-size: 13px;
    white-space: nowrap;
  }
  .home-page .trust-row {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    color: #516057;
    font-size: 12px;
  }
  .home-page .hero-card {
    background: #fff;
    border: 1px solid var(--mb-border, var(--line));
    border-radius: 20px;
    padding: 25px;
    box-shadow: 0 8px 26px rgba(20, 45, 28, .045);
  }
  .home-page .hero-card-top {
    font-size: 11px;
    letter-spacing: 1.4px;
    font-weight: 800;
    color: #607066;
    margin-bottom: 15px;
  }
  .home-page .live-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    background: #35a45f;
    border-radius: 50%;
    margin-right: 7px;
  }
  .home-page .flow-step {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 0;
    border-bottom: 1px solid #edf0ec;
    font-weight: 600;
    font-size: 14px;
  }
  .home-page .flow-step span {
    font-family: Manrope, system-ui, sans-serif;
    color: var(--green);
    font-size: 11px;
  }
  @media (max-width: 900px) {
    .home-page .hero-grid {
      grid-template-columns: 1fr;
      gap: 26px;
    }
    .home-page .hero-card {
      padding: 20px;
    }
  }
  @media (max-width: 620px) {
    .home-page .hero {
      padding: 44px 0 40px;
    }
    .home-page .hero h1 {
      letter-spacing: -.9px;
    }
    .home-page .hero-copy {
      font-size: 16px;
    }
    .home-page .hero-actions .btn {
      width: 100%;
    }
    .home-page .hero-account-cta {
      align-items: stretch;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 22px;
    }
    .home-page .hero-account-actions {
      width: 100%;
    }
    .home-page .hero-account-actions .btn {
      flex: 1;
      width: 50%;
    }
    .home-page .hero-card {
      border-radius: 16px;
    }
  }
  @media (max-width: 420px) {
    .home-page .hero h1 {
      font-size: 32px;
    }
  }
`;

const marketplaceCards = [
  { number: '01', title: 'Agricultural', description: 'Farm-produced goods such as potatoes, wheat, barley, vegetables, fruits, livestock-related products and other agricultural produce.', features: ['Farmers & producers', 'Bulk agricultural lots', 'Offers & negotiation', 'Inspection & evidence', 'Transport arrangement'], link: '/agricultural', button: 'Enter Agricultural Marketplace →' },
  { number: '02', title: 'Product', description: 'A broader marketplace for physical products sold by independent sellers to buyers through the MarketBridge platform.', features: ['Physical products', 'Independent sellers', 'Buyer discovery', 'Orders & records', 'Delivery options'], link: '/products', button: 'Browse Physical Products →' },
  { number: '03', title: 'Digital', description: 'A marketplace for independently supplied digital products and downloadable resources.', features: ['eBooks', 'Courses', 'Software', 'Documents & templates', 'Graphics & photos'], link: '/digital', button: 'Browse Digital Products →' },
];

export default function Home() {
  return (
    <main className="home-page">
      <style>{HOME_PAGE_STYLES}</style>
      <section className="hero">
        <div className="container-wide hero-grid">
          <div>
            <div className="eyebrow">MARKETBRIDGE PLATFORM</div>
            <h1>One platform for <em>agriculture, products and digital commerce.</em></h1>
            <p className="hero-copy">MarketBridge connects producers, farmers, sellers, buyers, investors and independent service providers through one marketplace platform.</p>
            <div className="hero-actions">
              <Link className="btn btn-primary btn-lg" to="/agricultural">Agricultural Marketplace →</Link>
              <Link className="btn btn-light btn-lg" to="/products">Browse Products</Link>
            </div>
            <div className="hero-account-cta" aria-label="MarketBridge account access">
              <div className="hero-account-copy">
                <strong>New to MarketBridge?</strong>
                <span>Start your marketplace journey — buy, sell, negotiate and grow with us.</span>
              </div>
              <div className="hero-account-actions">
                <Link className="btn btn-primary" to="/register">Join MarketBridge</Link>
                <Link className="btn btn-light" to="/login">Welcome back · Sign in</Link>
              </div>
            </div>
            <div className="trust-row">
              <span>✓ Independent sellers</span>
              <span>✓ Buyer & seller accounts</span>
              <span>✓ Marketplace records</span>
            </div>
          </div>
          <div className="hero-card">
            <div className="hero-card-top"><span className="live-dot"></span> MARKETBRIDGE STRUCTURE</div>
            <div className="flow">
              <div className="flow-step"><span>01</span> HOME</div>
              <div className="flow-step"><span>02</span> AGRICULTURAL</div>
              <div className="flow-step"><span>03</span> PRODUCT</div>
              <div className="flow-step"><span>04</span> DIGITAL</div>
            </div>
            <p className="small muted">MarketBridge provides the marketplace infrastructure connecting independent producers and sellers with buyers while supporting verification, communication, orders and approved marketplace services.</p>
          </div>
        </div>
      </section>

      <AdvertisementBanner />

      <section className="section">
        <div className="container-wide">
          <div className="section-heading">
            <div><span className="eyebrow">MARKETPLACE</span><h2>Three marketplaces under one MarketBridge platform.</h2></div>
          </div>
          <div className="three-grid">
            {marketplaceCards.map((m) => (
              <article className="feature-card" key={m.number}>
                <span className="feature-no">{m.number}</span>
                <h3>{m.title}</h3>
                <p>{m.description}</p>
                <ul className="marketplace-list">
                  {m.features.map((f) => <li key={f}>✓ {f}</li>)}
                </ul>
                <Link className="text-link" to={m.link}>{m.button}</Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container-wide split">
          <div>
            <span className="eyebrow">AGRICULTURAL MARKETPLACE</span>
            <h2>From farm fields to agricultural buyers.</h2>
            <p>Farmers and agricultural producers can list their produce directly on MarketBridge. Buyers can discover available lots, communicate with sellers, make offers, request inspection and arrange delivery.</p>
            <p>The farmer or producer remains the owner of the agricultural product. MarketBridge facilitates the transaction rather than purchasing or owning the produce.</p>
            <Link className="text-link" to="/agricultural">Enter Agricultural Marketplace →</Link>
          </div>
          <div className="mini-panel">
            <strong>Farmers</strong><span>List agricultural produce</span><hr />
            <strong>Buyers</strong><span>Discover and negotiate</span><hr />
            <strong>Inspectors</strong><span>Independent quality verification</span><hr />
            <strong>Transporters</strong><span>Own truck or hire through MarketBridge</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container-wide split reverse-mobile">
          <div className="mini-panel">
            <strong>Physical Products</strong><span>Products supplied by independent sellers</span><hr />
            <strong>Sellers</strong><span>Create listings and manage orders</span><hr />
            <strong>Buyers</strong><span>Discover products and purchase</span><hr />
            <strong>Marketplace</strong><span>Communication, records and transaction support</span>
          </div>
          <div>
            <span className="eyebrow">PRODUCT MARKETPLACE</span>
            <h2>A marketplace beyond agricultural produce.</h2>
            <p>MarketBridge can also connect buyers and sellers of general physical products. These products are independently supplied and owned by the sellers.</p>
            <p>This gives MarketBridge a broader marketplace structure while keeping the Agricultural section specialized for farm and agricultural transactions.</p>
            <Link className="text-link" to="/products">Explore Physical Products →</Link>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container-wide split">
          <div>
            <span className="eyebrow">DIGITAL MARKETPLACE</span>
            <h2>Digital products from independent creators and sellers.</h2>
            <p>MarketBridge also supports digital commerce. Sellers can offer useful digital products while retaining ownership and responsibility for their products.</p>
            <Link className="text-link" to="/digital">Explore Digital Marketplace →</Link>
          </div>
          <div className="mini-panel digital-panel">
            <strong>eBooks</strong><span>Books and digital publications</span><hr />
            <strong>Courses</strong><span>Educational and professional materials</span><hr />
            <strong>Software</strong><span>Software and digital licenses</span><hr />
            <strong>Creative Products</strong><span>Graphics, photos, templates and media</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container-wide">
          <div className="section-heading">
            <div><span className="eyebrow">HOW IT WORKS</span><h2>MarketBridge facilitates the marketplace.</h2></div>
          </div>
          <div className="three-grid">
            {pillars.map(([number, title, description]) => (
              <article className="feature-card" key={number}>
                <span className="feature-no">{number}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container-wide">
          <span className="eyebrow">MARKETPLACE TRANSACTION</span>
          <h2>Discover → Verify → Negotiate → Buy → Deliver</h2>
          <div className="hero-card">
            <div className="flow">
              <div className="flow-step"><span>01</span> Seller / Farmer lists</div>
              <div className="flow-step"><span>02</span> Buyer discovers</div>
              <div className="flow-step"><span>03</span> Inspection / evidence</div>
              <div className="flow-step"><span>04</span> Offer / negotiation</div>
              <div className="flow-step"><span>05</span> Order & payment</div>
              <div className="flow-step"><span>06</span> Own truck / hire transport</div>
              <div className="flow-step"><span>07</span> Delivery</div>
              <div className="flow-step"><span>08</span> Buyer confirms receipt</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container-wide">
          <div className="section-heading">
            <div><span className="eyebrow">JOIN MARKETBRIDGE</span><h2>Buy, sell, produce and participate in one platform.</h2><p>Choose the marketplace that fits what you want to buy or sell.</p></div>
          </div>
          <div className="hero-actions">
            <Link className="btn btn-primary" to="/agricultural">Agricultural</Link>
            <Link className="btn btn-light" to="/products">Products</Link>
            <Link className="btn btn-light" to="/digital">Digital</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
