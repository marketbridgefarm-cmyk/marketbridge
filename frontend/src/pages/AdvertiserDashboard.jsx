import React, { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { startChapaPayment, chapaInitializeAndRedirect } from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';

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

function campaignDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  return Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
}

export default function AdvertiserDashboard() {
  const { user } = useAuth();
  const [ads, setAds] = useState([]);
  const [myListings, setMyListings] = useState([]);
  const [dailyRates, setDailyRates] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [payingId, setPayingId] = useState(null);
  const [uploadingCreative, setUploadingCreative] = useState(false);

  const [form, setForm] = useState({
    type: 'BANNER',
    listingId: '',
    startDate: todayPlus(1),
    endDate: todayPlus(8),
    headline: '',
    linkUrl: '',
    creativeImageKey: '',
    creativePreviewUrl: '',
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [adsRes, listingsRes, pricingRes] = await Promise.all([
        api.get('/ads/mine'),
        api.get('/listings', { params: { sellerId: user?.id } }),
        api.get('/ads/pricing'),
      ]);
      setAds(adsRes.data?.ads || []);
      setMyListings(listingsRes.data?.listings || []);
      setDailyRates(pricingRes.data?.dailyRatesEtb || {});
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
  const needsCreative = form.type === 'BANNER';
  const days = campaignDays(form.startDate, form.endDate);
  const estimatedPrice = days > 0 && dailyRates[form.type] ? days * dailyRates[form.type] : null;

  const activityItems = ads.map((ad) => {
    const typeLabel = AD_TYPES.find((t) => t.value === ad.type)?.label || 'Campaign';
    const statusLabel = STATUS_LABELS[ad.status] || ad.status;
    const listingSuffix = ad.listing?.cropType || ad.listing?.title ? ` for ${ad.listing.cropType || ad.listing.title}` : '';
    return {
      id: `ad-${ad.id}`,
      icon: '📣',
      text: `${typeLabel}${listingSuffix} is ${statusLabel.toLowerCase()}`,
      time: ad.updatedAt || ad.createdAt,
      href: ad.listing?.id ? `/listings/${ad.listing.id}` : undefined,
    };
  });

  async function handleCreativeSelect(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    clearMessages();
    setUploadingCreative(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const { data } = await api.post('/ads/creative', body);
      setForm((f) => ({ ...f, creativeImageKey: data.key, creativePreviewUrl: URL.createObjectURL(file) }));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not upload banner image');
    } finally {
      setUploadingCreative(false);
    }
  }

  async function submitAd(e) {
    e.preventDefault();
    clearMessages();

    if (needsListing && !form.listingId) {
      setError('Select a listing to feature for this campaign type.');
      return;
    }

    if (needsCreative && (!form.headline || !form.creativeImageKey)) {
      setError('Banner campaigns need a headline and an uploaded image.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/ads', {
        type: form.type,
        listingId: needsListing ? form.listingId : undefined,
        startDate: new Date(form.startDate).toISOString(),
        endDate: new Date(form.endDate).toISOString(),
        headline: form.headline || undefined,
        linkUrl: form.linkUrl || undefined,
        creativeImageKey: needsCreative ? form.creativeImageKey : undefined,
      });
      setSuccess('Campaign submitted — pay below to activate it.');
      setForm((f) => ({ ...f, listingId: '', headline: '', linkUrl: '', creativeImageKey: '', creativePreviewUrl: '' }));
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create campaign');
    } finally {
      setSubmitting(false);
    }
  }

  async function payForAd(ad) {
    clearMessages();
    setPayingId(ad.id);
    try {
      await startChapaPayment({
        type: 'ADVERTISING',
        advertisementId: ad.id,
        amount: Number(ad.amountPaid),
        method: 'TELEBIRR',
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not start payment');
      setPayingId(null);
    }
  }

  async function resumeAdPayment(paymentId, adId) {
    clearMessages();
    setPayingId(adId);
    try {
      await chapaInitializeAndRedirect(paymentId);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not resume payment');
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
        <DashboardWelcome user={user} subtitle="Promote a listing, or run a platform-wide banner or Telegram placement." />
        <div className="page-header">
          <div>
            <span className="eyebrow">ADVERTISING</span>
            <h1>Your campaigns.</h1>
            <p>Promote a listing, or run a platform-wide banner or Telegram placement.</p>
          </div>
        </div>

        <RoleSwitchCTA current="ADVERTISER" />
        <RecentActivity items={activityItems} emptyText="No campaigns yet — create one below." />

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

              {needsCreative && (
                <>
                  <label>Headline</label>
                  <input
                    value={form.headline}
                    onChange={(e) => setForm((f) => ({ ...f, headline: e.target.value }))}
                    placeholder="What the banner says"
                    maxLength={140}
                    required
                  />
                  <label>Link (optional)</label>
                  <input
                    value={form.linkUrl}
                    onChange={(e) => setForm((f) => ({ ...f, linkUrl: e.target.value }))}
                    placeholder="https://... where clicking the banner goes"
                  />
                  <label>Banner image</label>
                  <input type="file" accept="image/*" onChange={handleCreativeSelect} disabled={uploadingCreative} />
                  {form.creativePreviewUrl && (
                    <div className="media-preview-grid">
                      <div className="media-preview-item">
                        <img src={form.creativePreviewUrl} alt="Banner preview" />
                      </div>
                    </div>
                  )}
                  {uploadingCreative && <p className="muted">Uploading image…</p>}
                </>
              )}

              {form.type === 'TELEGRAM_PROMOTION' && (
                <>
                  <label>Promotion message</label>
                  <input
                    value={form.headline}
                    onChange={(e) => setForm((f) => ({ ...f, headline: e.target.value }))}
                    placeholder="What you'd like posted"
                    maxLength={140}
                  />
                  <p className="muted">Telegram promotions are posted manually by the MarketBridge team after payment — there's no automatic posting yet.</p>
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

              {estimatedPrice != null && (
                <p className="muted" style={{ marginTop: 8 }}>
                  Estimated price: <strong>{estimatedPrice.toLocaleString()} ETB</strong> for {days} day{days === 1 ? '' : 's'} ({dailyRates[form.type]?.toLocaleString()} ETB/day)
                </p>
              )}

              <div className="sd-modal-actions" style={{ marginTop: 20 }}>
                <button className="btn btn-primary" type="submit" disabled={submitting || uploadingCreative}>
                  {submitting ? 'Submitting…' : 'Submit campaign'}
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <h2>How it works</h2>
            <p className="muted">
              1. Submit a campaign — its exact price is fixed by MarketBridge at that point, based on campaign type and how many days you chose.
            </p>
            <p className="muted">
              2. Pay the fixed amount shown on the campaign card below.
            </p>
            <p className="muted">
              3. Once Chapa confirms your payment, the campaign automatically goes <strong>Active</strong> for the dates you chose — except Banner campaigns, which also need a quick admin content check first since they show your own image and text on the homepage.
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
            {ads.map((ad) => {
              const pending = (ad.payments || []).find((p) => p.status === 'PENDING');
              const paid = (ad.payments || []).find((p) => p.status === 'PAID');

              return (
                <div className="sd-panel" key={ad.id}>
                  {ad.creativeImageUrl && (
                    <img src={ad.creativeImageUrl} alt={ad.headline || 'Campaign creative'} style={{ width: '100%', borderRadius: 10, marginBottom: 10, maxHeight: 140, objectFit: 'cover' }} />
                  )}
                  <h3>{AD_TYPES.find((t) => t.value === ad.type)?.label || ad.type}</h3>
                  {ad.headline && <p className="muted">{ad.headline}</p>}
                  <p className="muted">
                    {ad.listing ? `Featuring: ${ad.listing.title || ad.listing.cropType}` : 'Platform-wide placement'}
                  </p>
                  <p className="muted">
                    {new Date(ad.startDate).toLocaleDateString()} — {new Date(ad.endDate).toLocaleDateString()}
                  </p>
                  <span className="sd-badge">{STATUS_LABELS[ad.status] || ad.status}</span>
                  <p className="muted" style={{ marginTop: 8 }}>
                    {paid ? `Paid: ${Number(ad.amountPaid).toLocaleString()} ETB` : `Amount due: ${Number(ad.amountPaid).toLocaleString()} ETB`}
                  </p>

                  {!paid && pending && (
                    <div style={{ marginTop: 12 }}>
                      <p className="muted">Your payment hasn't completed yet.</p>
                      <button
                        type="button"
                        className="sd-btn sd-btn-primary"
                        disabled={payingId === ad.id}
                        onClick={() => resumeAdPayment(pending.id, ad.id)}
                      >
                        {payingId === ad.id ? 'Redirecting…' : 'Resume payment'}
                      </button>
                    </div>
                  )}

                  {!paid && !pending && ad.status === 'PENDING' && (
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="sd-btn sd-btn-primary"
                        disabled={payingId === ad.id}
                        onClick={() => payForAd(ad)}
                      >
                        {payingId === ad.id ? 'Redirecting…' : `Pay ${Number(ad.amountPaid).toLocaleString()} ETB`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
