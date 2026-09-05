import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';

const AD_TYPES = [
  { value: 'FEATURED_LISTING', label: 'Featured Listing' },
  { value: 'TOP_OF_CATEGORY', label: 'Top of Category' },
  { value: 'SPONSORED_SEARCH', label: 'Sponsored Search' },
  { value: 'BANNER', label: 'Banner' },
  { value: 'TELEGRAM_PROMOTION', label: 'Telegram Promotion' },
];

const LISTING_LINKED_TYPES = ['FEATURED_LISTING', 'TOP_OF_CATEGORY', 'SPONSORED_SEARCH'];

const STATUS_LABELS = {
  PENDING: 'Pending review',
  ACTIVE: 'Active',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function AdvertiserDashboard() {
  const { user } = useAuth();
  const [ads, setAds] = useState([]);
  const [myListings, setMyListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [payingId, setPayingId] = useState(null);

  const [form, setForm] = useState({
    type: 'BANNER',
    listingId: '',
    startDate: todayPlus(1),
    endDate: todayPlus(8),
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [adsRes, listingsRes] = await Promise.all([
        api.get('/ads/mine'),
        api.get('/listings', { params: { sellerId: user?.id } }),
      ]);
      setAds(adsRes.data?.ads || []);
      setMyListings(listingsRes.data?.listings || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your advertising campaigns');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function clearMessages() {
    setError('');
    setSuccess('');
  }

  const needsListing = LISTING_LINKED_TYPES.includes(form.type);

  async function submitAd(e) {
    e.preventDefault();
    clearMessages();

    if (needsListing && !form.listingId) {
      setError('Select a listing to feature for this campaign type.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/ads', {
        type: form.type,
        listingId: needsListing ? form.listingId : undefined,
        startDate: new Date(form.startDate).toISOString(),
        endDate: new Date(form.endDate).toISOString(),
      });
      setSuccess('Campaign submitted for review.');
      setForm((f) => ({ ...f, listingId: '' }));
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create campaign');
    } finally {
      setSubmitting(false);
    }
  }

  async function payForAd(ad, e) {
    e.preventDefault();
    clearMessages();

    const data = new FormData(e.target);
    const amount = Number(data.get('amount'));
    const method = data.get('method');

    if (!amount || amount <= 0) {
      setError('Enter a valid amount.');
      return;
    }

    setPayingId(ad.id);
    try {
      await api.post('/payments', {
        type: 'ADVERTISING',
        advertisementId: ad.id,
        amount,
        method,
      });
      setSuccess('Payment recorded. An admin will confirm it and review your campaign.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit payment');
    } finally {
      setPayingId(null);
    }
  }

  if (loading && ads.length === 0) {
    return (
      <main className="section">
        <div className="container-wide loading">Loading your campaigns…</div>
      </main>
    );
  }

  return (
    <main className="section">
      <div className="container-wide">
        <div className="page-header">
          <div>
            <span className="eyebrow">ADVERTISING</span>
            <h1>Your campaigns.</h1>
            <p>Promote a listing, or run a platform-wide banner or Telegram placement.</p>
          </div>
        </div>

        <RoleSwitchCTA current="ADVERTISER" />

        {error && <div className="alert error">{error}</div>}
        {success && <div className="alert">{success}</div>}

        <div className="admin-grid">
          <div className="card">
            <h2>New campaign</h2>
            <form onSubmit={submitAd}>
              <label>Campaign type</label>
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, listingId: '' }))}
              >
                {AD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>

              {needsListing && (
                <>
                  <label>Listing to feature</label>
                  <select
                    value={form.listingId}
                    onChange={(e) => setForm((f) => ({ ...f, listingId: e.target.value }))}
                    required
                  >
                    <option value="">Select one of your listings…</option>
                    {myListings.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title || l.cropType} — {l.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                  {myListings.length === 0 && (
                    <p className="muted">You have no active listings to feature yet.</p>
                  )}
                </>
              )}

              <label>Start date</label>
              <input
                type="date"
                value={form.startDate}
                min={todayPlus(0)}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                required
              />

              <label>End date</label>
              <input
                type="date"
                value={form.endDate}
                min={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                required
              />

              <div className="sd-modal-actions" style={{ marginTop: 20 }}>
                <button className="btn btn-primary" type="submit" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit for review'}
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <h2>How it works</h2>
            <p className="muted">
              1. Submit a campaign — it starts as <strong>Pending review</strong>.
            </p>
            <p className="muted">
              2. Record payment for it below (any of your usual payment methods).
            </p>
            <p className="muted">
              3. An admin confirms the payment and approves the campaign, which then goes <strong>Active</strong> for the dates you chose.
            </p>
          </div>
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <h2>My campaigns</h2>
            <button type="button" className="btn btn-light" onClick={loadAll} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {ads.length === 0 && <p className="muted">You haven't created any campaigns yet.</p>}

          <div className="sd-flow">
            {ads.map((ad) => (
              <div className="sd-panel" key={ad.id}>
                <h3>{AD_TYPES.find((t) => t.value === ad.type)?.label || ad.type}</h3>
                <p className="muted">
                  {ad.listing ? `Featuring: ${ad.listing.title || ad.listing.cropType}` : 'Platform-wide placement'}
                </p>
                <p className="muted">
                  {new Date(ad.startDate).toLocaleDateString()} — {new Date(ad.endDate).toLocaleDateString()}
                </p>
                <span className="sd-badge">{STATUS_LABELS[ad.status] || ad.status}</span>
                <p className="muted" style={{ marginTop: 8 }}>
                  {ad.amountPaid != null ? `Paid: ${Number(ad.amountPaid).toLocaleString()} ETB` : 'No payment recorded yet'}
                </p>

                {ad.status === 'PENDING' && ad.amountPaid == null && (
                  <form onSubmit={(e) => payForAd(ad, e)} style={{ marginTop: 12 }}>
                    <label>Amount (ETB)</label>
                    <input name="amount" type="number" min="1" step="0.01" required />
                    <label>Payment method</label>
                    <select name="method" defaultValue="TELEBIRR">
                      <option value="TELEBIRR">Telebirr</option>
                      <option value="CBE">CBE</option>
                      <option value="QR">QR</option>
                      <option value="OTHER">Other</option>
                    </select>
                    <button className="sd-btn sd-btn-primary" style={{ marginTop: 8 }} disabled={payingId === ad.id}>
                      {payingId === ad.id ? 'Submitting…' : 'Record payment'}
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
