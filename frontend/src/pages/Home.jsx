import React from 'react';
import { Link } from 'react-router-dom';

const pillars = [
  [
    '01',
    'Agricultural marketplace',
    'Connect farmers, agricultural producers, investors and buyers for farm-produced goods, including bulk and time-sensitive harvests.',
  ],
  [
    '02',
    'Physical products',
    'Buy and sell general physical products through independent sellers and buyers without MarketBridge owning the merchandise.',
  ],
  [
    '03',
    'Digital marketplace',
    'Discover and sell eBooks, courses, software, documents, templates, graphics, photos and other digital products.',
  ],
];

const marketplaceCards = [
  {
    number: '01',
    title: 'Agricultural',
    description:
      'Farm-produced goods such as potatoes, wheat, barley, vegetables, fruits, livestock-related products and other agricultural produce.',
    features: [
      'Farmers & producers',
      'Bulk agricultural lots',
      'Offers & negotiation',
      'Inspection & evidence',
      'Transport arrangement',
    ],
    link: '/agricultural',
    button: 'Enter Agricultural Marketplace →',
  },
  {
    number: '02',
    title: 'Product',
    description:
      'A broader marketplace for physical products sold by independent sellers to buyers through the MarketBridge platform.',
    features: [
      'Physical products',
      'Independent sellers',
      'Buyer discovery',
      'Orders & records',
      'Delivery options',
    ],
    link: '/products',
    button: 'Browse Physical Products →',
  },
  {
    number: '03',
    title: 'Digital',
    description:
      'A marketplace for independently supplied digital products and downloadable resources.',
    features: [
      'eBooks',
      'Courses',
      'Software',
      'Documents & templates',
      'Graphics & photos',
    ],
    link: '/digital',
    button: 'Browse Digital Products →',
  },
];

export default function Home() {
  return (
    <main>

      {/* ============================================================
          HERO
      ============================================================ */}

      <section className="hero">
        <div className="container-wide hero-grid">

          <div>
            <div className="eyebrow">
              MARKETBRIDGE PLATFORM
            </div>

            <h1>
              One platform for{' '}
              <em>agriculture, products and digital commerce.</em>
            </h1>

            <p className="hero-copy">
              MarketBridge connects producers, farmers, sellers,
              buyers, investors and independent service providers
              through one marketplace platform.
            </p>

            <div className="hero-actions">

              <Link
                className="btn btn-primary btn-lg"
                to="/agricultural"
              >
                Agricultural Marketplace →
              </Link>

              <Link
                className="btn btn-light btn-lg"
                to="/products"
              >
                Browse Products
              </Link>

            </div>

            <div className="trust-row">
              <span>✓ Independent sellers</span>
              <span>✓ Buyer & seller accounts</span>
              <span>✓ Marketplace records</span>
            </div>
          </div>


          {/* PLATFORM MAP */}

          <div className="hero-card">

            <div className="hero-card-top">
              <span className="live-dot"></span>
              MARKETBRIDGE STRUCTURE
            </div>

            <div className="flow">

              <div className="flow-step">
                <span>01</span>
                HOME
              </div>

              <div className="flow-step">
                <span>02</span>
                AGRICULTURAL
              </div>

              <div className="flow-step">
                <span>03</span>
                PRODUCT
              </div>

              <div className="flow-step">
                <span>04</span>
                DIGITAL
              </div>

            </div>

            <p className="small muted">
              MarketBridge provides the marketplace infrastructure
              connecting independent producers and sellers with
              buyers while supporting verification, communication,
              orders and approved marketplace services.
            </p>

          </div>

        </div>
      </section>


      {/* ============================================================
          MARKETPLACE OVERVIEW
      ============================================================ */}

      <section className="section">

        <div className="container-wide">

          <div className="section-heading">

            <div>
              <span className="eyebrow">
                MARKETPLACE
              </span>

              <h2>
                Three marketplaces under one MarketBridge platform.
              </h2>
            </div>

          </div>


          <div className="three-grid">

            {marketplaceCards.map((marketplace) => (

              <article
                className="feature-card"
                key={marketplace.number}
              >

                <span className="feature-no">
                  {marketplace.number}
                </span>

                <h3>
                  {marketplace.title}
                </h3>

                <p>
                  {marketplace.description}
                </p>

                <ul className="marketplace-list">

                  {marketplace.features.map((feature) => (
                    <li key={feature}>
                      ✓ {feature}
                    </li>
                  ))}

                </ul>

                <Link
                  className="text-link"
                  to={marketplace.link}
                >
                  {marketplace.button}
                </Link>

              </article>

            ))}

          </div>

        </div>

      </section>


      {/* ============================================================
          AGRICULTURAL MARKETPLACE
      ============================================================ */}

      <section className="section section-alt">

        <div className="container-wide split">

          <div>

            <span className="eyebrow">
              AGRICULTURAL MARKETPLACE
            </span>

            <h2>
              From farm fields to agricultural buyers.
            </h2>

            <p>
              Farmers and agricultural producers can list their
              produce directly on MarketBridge. Buyers can discover
              available lots, communicate with sellers, make offers,
              request inspection and arrange delivery.
            </p>

            <p>
              The farmer or producer remains the owner of the
              agricultural product. MarketBridge facilitates the
              transaction rather than purchasing or owning the
              produce.
            </p>

            <Link
              className="text-link"
              to="/agricultural"
            >
              Enter Agricultural Marketplace →
            </Link>

          </div>


          <div className="mini-panel">

            <strong>Farmers</strong>
            <span>List agricultural produce</span>

            <hr />

            <strong>Buyers</strong>
            <span>Discover and negotiate</span>

            <hr />

            <strong>Inspectors</strong>
            <span>Independent quality verification</span>

            <hr />

            <strong>Transporters</strong>
            <span>Own truck or hire through MarketBridge</span>

          </div>

        </div>

      </section>


      {/* ============================================================
          PRODUCT MARKETPLACE
      ============================================================ */}

      <section className="section">

        <div className="container-wide split reverse-mobile">

          <div className="mini-panel">

            <strong>Physical Products</strong>
            <span>
              Products supplied by independent sellers
            </span>

            <hr />

            <strong>Sellers</strong>
            <span>
              Create listings and manage orders
            </span>

            <hr />

            <strong>Buyers</strong>
            <span>
              Discover products and purchase
            </span>

            <hr />

            <strong>Marketplace</strong>
            <span>
              Communication, records and transaction support
            </span>

          </div>


          <div>

            <span className="eyebrow">
              PRODUCT MARKETPLACE
            </span>

            <h2>
              A marketplace beyond agricultural produce.
            </h2>

            <p>
              MarketBridge can also connect buyers and sellers of
              general physical products. These products are
              independently supplied and owned by the sellers.
            </p>

            <p>
              This gives MarketBridge a broader marketplace structure
              while keeping the Agricultural section specialized for
              farm and agricultural transactions.
            </p>

            <Link
              className="text-link"
              to="/products"
            >
              Explore Physical Products →
            </Link>

          </div>

        </div>

      </section>


      {/* ============================================================
          DIGITAL MARKETPLACE
      ============================================================ */}

      <section className="section section-alt">

        <div className="container-wide split">

          <div>

            <span className="eyebrow">
              DIGITAL MARKETPLACE
            </span>

            <h2>
              Digital products from independent creators and sellers.
            </h2>

            <p>
              MarketBridge also supports digital commerce. Sellers
              can offer useful digital products while retaining
              ownership and responsibility for their products.
            </p>

            <Link
              className="text-link"
              to="/digital"
            >
              Explore Digital Marketplace →
            </Link>

          </div>


          <div className="mini-panel digital-panel">

            <strong>eBooks</strong>
            <span>Books and digital publications</span>

            <hr />

            <strong>Courses</strong>
            <span>Educational and professional materials</span>

            <hr />

            <strong>Software</strong>
            <span>Software and digital licenses</span>

            <hr />

            <strong>Creative Products</strong>
            <span>Graphics, photos, templates and media</span>

          </div>

        </div>

      </section>


      {/* ============================================================
          HOW MARKETBRIDGE WORKS
      ============================================================ */}

      <section className="section">

        <div className="container-wide">

          <div className="section-heading">

            <div>
              <span className="eyebrow">
                HOW IT WORKS
              </span>

              <h2>
                MarketBridge facilitates the marketplace.
              </h2>
            </div>

          </div>


          <div className="three-grid">

            {pillars.map(([number, title, description]) => (

              <article
                className="feature-card"
                key={number}
              >

                <span className="feature-no">
                  {number}
                </span>

                <h3>
                  {title}
                </h3>

                <p>
                  {description}
                </p>

              </article>

            ))}

          </div>

        </div>

      </section>


      {/* ============================================================
          TRANSACTION WORKFLOW
      ============================================================ */}

      <section className="section section-alt">

        <div className="container-wide">

          <span className="eyebrow">
            MARKETPLACE TRANSACTION
          </span>

          <h2>
            Discover → Verify → Negotiate → Buy → Deliver
          </h2>

          <div className="hero-card">

            <div className="flow">

              <div className="flow-step">
                <span>01</span>
                Seller / Farmer lists
              </div>

              <div className="flow-step">
                <span>02</span>
                Buyer discovers
              </div>

              <div className="flow-step">
                <span>03</span>
                Inspection / evidence
              </div>

              <div className="flow-step">
                <span>04</span>
                Offer / negotiation
              </div>

              <div className="flow-step">
                <span>05</span>
                Order & payment
              </div>

              <div className="flow-step">
                <span>06</span>
                Own truck / hire transport
              </div>

              <div className="flow-step">
                <span>07</span>
                Delivery
              </div>

              <div className="flow-step">
                <span>08</span>
                Buyer confirms receipt
              </div>

            </div>

          </div>

        </div>

      </section>


      {/* ============================================================
          FINAL CTA
      ============================================================ */}

      <section className="section">

        <div className="container-wide">

          <div className="section-heading">

            <div>

              <span className="eyebrow">
                JOIN MARKETBRIDGE
              </span>

              <h2>
                Buy, sell, produce and participate in one platform.
              </h2>

              <p>
                Choose the marketplace that fits what you want to
                buy or sell.
              </p>

            </div>

          </div>


          <div className="hero-actions">

            <Link
              className="btn btn-primary"
              to="/agricultural"
            >
              Agricultural
            </Link>

            <Link
              className="btn btn-light"
              to="/products"
            >
              Products
            </Link>

            <Link
              className="btn btn-light"
              to="/digital"
            >
              Digital
            </Link>

          </div>

        </div>

      </section>

    </main>
  );
}
