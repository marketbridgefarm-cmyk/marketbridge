import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Services() {
  const { user } = useAuth();
  const roles = user?.roles || [];

  return (
    <main className="section">
      <div className="container-wide services-page">
        <div className="page-header">
          <div>
            <span className="eyebrow">MARKET SERVICES</span>
            <h1>Services for your transaction</h1>
            <p className="lead">You can use MarketBridge transport and inspection services as a buyer or seller. The provider roles are handled separately.</p>
          </div>
        </div>

        <div className="service-access-grid service-access-grid-large">
          <Link to="/orders" className="service-access-card service-access-card-large">
            <span className="service-access-icon" aria-hidden="true">🚛</span>
            <span className="service-access-copy">
              <strong>Arrange Transport</strong>
              <span>Open your orders, choose an order, then arrange transport. You can use your own truck or hire a registered transporter matched to the load.</span>
              <em>Start from My Orders →</em>
            </span>
            <span className="service-access-arrow" aria-hidden="true">→</span>
          </Link>

          <Link to="/agricultural" className="service-access-card service-access-card-large">
            <span className="service-access-icon" aria-hidden="true">🔍</span>
            <span className="service-access-copy">
              <strong>Request Inspection</strong>
              <span>Browse agricultural listings, open the listing you want checked, and use its inspection section to request an inspector or review available inspection quotes.</span>
              <em>Browse agricultural listings →</em>
            </span>
            <span className="service-access-arrow" aria-hidden="true">→</span>
          </Link>
        </div>

        {(roles.includes('INSPECTOR') || roles.includes('TRUCK_OWNER')) && (
          <section className="provider-service-panel">
            <span className="eyebrow">PROVIDER ACCESS</span>
            <h2>Fulfil service requests</h2>
            <p className="muted">Your provider dashboard is separate from the buyer/seller service request flow.</p>
            <div className="service-provider-links">
              {roles.includes('TRUCK_OWNER') && <Link className="btn btn-primary" to="/dashboard/truck-owner">🚛 Transporter Dashboard</Link>}
              {roles.includes('INSPECTOR') && <Link className="btn btn-primary" to="/dashboard/inspector">🔍 Inspector Dashboard</Link>}
            </div>
          </section>
        )}

        <div className="service-help-note">
          <strong>How the separation works</strong>
          <span>Buyer/Seller requests the service → MarketBridge routes the request → registered Transporter/Inspector fulfils it → the order or listing records the service activity.</span>
        </div>
      </div>
    </main>
  );
}
