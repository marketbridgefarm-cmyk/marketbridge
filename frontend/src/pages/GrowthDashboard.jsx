import React, { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

const money = (n) => `${Number(n || 0).toLocaleString()} ETB`;

export default function GrowthDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [promotions, setPromotions] = useState([]);
  const [referral, setReferral] = useState(null);
  const [promoCode, setPromoCode] = useState('');
  const [claimMessage, setClaimMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    Promise.all([api.get('/growth/analytics/me'), api.get('/growth/promotions')])
      .then(([analytics, promos]) => { setData(analytics.data.analytics); setPromotions(promos.data.promotions || []); })
      .catch((e) => setError(e.response?.data?.error || 'Could not load growth dashboard'));
    api.post('/growth/referrals/mine').then(r => setReferral(r.data.referral)).catch(() => {});
  }, [user]);

  async function claimReferral(e) {
    e.preventDefault(); setClaimMessage(''); setError('');
    try { await api.post('/growth/referrals/claim', { code: promoCode }); setClaimMessage('Referral code claimed successfully.'); setPromoCode(''); }
    catch (e) { setError(e.response?.data?.error || 'Could not claim referral code'); }
  }

  if (!user) return null;
  return (
    <main className="page"><div className="container">
      <div className="page-header"><div><h1>Growth & Analytics</h1><p className="muted">Track marketplace performance, promotions and referrals.</p></div></div>
      {error && <div className="alert error">{error}</div>}
      {claimMessage && <div className="alert success">{claimMessage}</div>}
      {data && <div className="listing-grid" style={{ marginBottom: 24 }}>
        <div className="card"><h3>Sales</h3><p><strong>{money(data.seller.grossSales)}</strong></p><p className="muted">{data.seller.completedSales} completed sales · {data.seller.activeListings} active listings</p><p>Rating: {data.seller.averageRating || '—'} / 5</p></div>
        <div className="card"><h3>Buying</h3><p><strong>{money(data.buyer.spend)}</strong></p><p className="muted">{data.buyer.completedPurchases} completed purchases</p></div>
        <div className="card"><h3>Advertising</h3><p><strong>{data.advertising.impressions.toLocaleString()}</strong> impressions</p><p className="muted">{data.advertising.clicks.toLocaleString()} clicks · {data.advertising.ctr}% CTR</p></div>
      </div>}
      <div className="card" style={{ marginBottom: 24 }}><h2>Available promotions</h2>{!promotions.length ? <p className="muted">No active promotions right now.</p> : <div>{promotions.map(p => <div key={p.code} style={{ padding: '10px 0', borderBottom: '1px solid #ddd' }}><strong>{p.code}</strong> — {p.discountType === 'PERCENTAGE' ? `${Number(p.discountValue)}% off` : `${money(p.discountValue)} off`} {Number(p.minimumSubtotal) > 0 ? `on orders over ${money(p.minimumSubtotal)}` : ''}<span className="muted"> · ends {new Date(p.endsAt).toLocaleDateString()}</span></div>)}</div>}</div>
      <div className="card"><h2>Referral program</h2><p className="muted">Share your code with new MarketBridge users.</p>{referral && <p><strong>Your referral code: {referral.code}</strong> · {referral.claimCount} claims</p>}<form onSubmit={claimReferral} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><input value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())} placeholder="Enter someone else's referral code" /><button className="btn btn-primary" type="submit">Claim referral</button></form></div>
    </div></main>
  );
}
