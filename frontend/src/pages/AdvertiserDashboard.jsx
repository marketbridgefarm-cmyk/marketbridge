import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { startChapaPayment, chapaInitializeAndRedirect } from '../utils/chapaCheckout';
import { useAuth } from '../context/AuthContext.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';
import ImageCarousel from '../components/ImageCarousel.jsx';

// Only TELEBIRR and QR route to a configured payment adapter (both go
// through Chapa's hosted checkout — see
// backend/src/services/paymentProviders/index.js). CBE and OTHER are
// deliberately left unconfigured there, so they're not offered here.
const PAYMENT_METHODS = [
  { value: 'TELEBIRR', label: 'Telebirr via Chapa' },
  { value: 'QR', label: 'QR Code' },
];

const AD_TYPES = [
  { value: 'FEATURED_LISTING', label: 'Featured Listing', help: 'Promote an active listing across marketplace results.' },
  { value: 'TOP_OF_CATEGORY', label: 'Top of Category', help: 'Give an active listing the strongest category placement.' },
  { value: 'SPONSORED_SEARCH', label: 'Sponsored Search', help: 'Boost an active listing when buyers search.' },
  { value: 'BANNER', label: 'Banner', help: 'Run a moderated platform-wide image campaign.' },
  { value: 'TELEGRAM_PROMOTION', label: 'Telegram Promotion', help: 'Pay for a MarketBridge Telegram promotion, then the team publishes it manually.' },
];

const BANNER_TEMPLATE_OPTIONS = [
  { value: 'CLASSIC', label: 'Classic', help: 'Full-width image with a dark caption strip over the bottom-left corner.' },
  { value: 'BOLD', label: 'Bold', help: 'Large centered headline over a high-contrast color wash.' },
  { value: 'MINIMAL', label: 'Minimal', help: 'Clean image with a small caption below it and no photo overlay.' },
  { value: 'CARD', label: 'Card', help: 'Framed card with a Sponsored ribbon and headline beneath the image.' },
  { value: 'SPLIT', label: 'Split', help: 'Elegant two-column composition with image on one side and message on the other.' },
  { value: 'EDITORIAL', label: 'Editorial', help: 'Premium magazine-style treatment with refined typography and a soft image veil.' },
  { value: 'FRESH', label: 'Farm Fresh', help: 'Warm agricultural style with a fresh badge and strong callout.' },
  { value: 'DARK_LUXE', label: 'Dark Luxe', help: 'Premium dark treatment with a subtle gold accent for high-end campaigns.' },
  { value: 'MARKET', label: 'Market', help: 'Energetic marketplace treatment with a compact promotional badge.' },
  { value: 'GRADIENT', label: 'Gradient', help: 'Modern full-bleed image with a polished gradient headline panel.' },
];

// TELEGRAM_PROMOTION message/tone templates. Purely a copy starting point —
// MarketBridge staff still write and publish the actual Telegram post — so
// picking one just fills the message box with an example the advertiser can
// edit, and (unlike banner templates) never changes price.
const TELEGRAM_TEMPLATE_OPTIONS = [
  {
    value: 'CLASSIC',
    label: 'Classic',
    icon: '📢',
    anim: 'tg-anim-classic',
    help: 'Simple, straightforward announcement.',
    starter: '📢 New on MarketBridge: quality produce available now. Check it out and place your order today.',
  },
  {
    value: 'HOT_DEAL',
    label: 'Hot Deal',
    icon: '🔥',
    anim: 'tg-anim-hotdeal',
    help: 'Urgency-driven, built to grab attention fast.',
    starter: '🔥 HOT DEAL on MarketBridge! Limited quantity at a great price — don\u2019t miss out, order now before it\u2019s gone.',
  },
  {
    value: 'FRESH_HARVEST',
    label: 'Fresh Harvest',
    icon: '🌱',
    anim: 'tg-anim-fresh',
    help: 'Leads with freshness and quality.',
    starter: '🌱 Fresh off the farm! Just harvested and ready for delivery through MarketBridge — order while it\u2019s at its best.',
  },
  {
    value: 'FARM_TO_TABLE',
    label: 'Farm to Table',
    icon: '🚜',
    anim: 'tg-anim-farm',
    help: 'Warm, story-driven — from the farm straight to the buyer.',
    starter: '🚜 From our farm to your table. Trusted quality, fair prices, and reliable delivery — only on MarketBridge.',
  },
  {
    value: 'FLASH_SALE',
    label: 'Flash Sale',
    icon: '⏰',
    anim: 'tg-anim-flash',
    help: 'Countdown energy for a short promotional window.',
    starter: '⏰ FLASH SALE — today only on MarketBridge! Grab this offer before the window closes.',
  },
  {
    value: 'TRUSTED_SELLER',
    label: 'Trusted Seller',
    icon: '✅',
    anim: 'tg-anim-trusted',
    help: 'Credibility-first, for building buyer confidence.',
    starter: '✅ Verified seller on MarketBridge. Consistent quality and dependable delivery — see why buyers keep coming back.',
  },
  {
    value: 'CAROUSEL',
    label: 'Photo Carousel',
    icon: '🎠',
    anim: 'tg-anim-carousel',
    help: 'A swipeable album of your own photos, with your message as the caption.',
    starter: '🎠 Swipe through the latest from our farm — fresh produce, ready to order on MarketBridge.',
  },
];

// Fallback until GET /ads/pricing reports the server's real carousel limits.
const DEFAULT_CAROUSEL_LIMITS = { minImages: 2, maxImages: 10, maxFileBytes: 5 * 1024 * 1024 };

const LISTING_LINKED_TYPES = ['FEATURED_LISTING', 'TOP_OF_CATEGORY', 'SPONSORED_SEARCH'];

const STATUS_LABELS = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID_PENDING_REVIEW: 'Paid — pending review',
  APPROVED: 'Approved',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  ACTIVE: 'Published',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  PENDING: 'Awaiting review',
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
  return Math.max(1, Math.ceil((end - start) / 86400000));
}

function statusClass(status) {
  if (['PUBLISHED', 'ACTIVE', 'APPROVED', 'SCHEDULED'].includes(status)) return 'sd-badge sd-good';
  if (['REJECTED', 'EXPIRED', 'CANCELLED'].includes(status)) return 'sd-badge sd-red';
  return 'sd-badge sd-warn';
}

export default function AdvertiserDashboard() {
  const { user } = useAuth();
  const [ads, setAds] = useState([]);
  const [myListings, setMyListings] = useState([]);
  const [dailyRates, setDailyRates] = useState({});
  const [templateMultipliers, setTemplateMultipliers] = useState({});
  const [maxCampaignDays, setMaxCampaignDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [payingId, setPayingId] = useState(null);
  const [payMethod, setPayMethod] = useState('TELEBIRR');
  const [uploadingCreative, setUploadingCreative] = useState(false);
  const [uploadingCarousel, setUploadingCarousel] = useState(false);
  const [carouselLimits, setCarouselLimits] = useState(DEFAULT_CAROUSEL_LIMITS);
  const [analytics, setAnalytics] = useState({});

  const [form, setForm] = useState({
    type: 'FEATURED_LISTING',
    listingId: '',
    startDate: todayPlus(1),
    endDate: todayPlus(8),
    headline: '',
    linkUrl: '',
    creativeImageKey: '',
    creativePreviewUrl: '',
    bannerTemplate: 'CLASSIC',
    telegramTemplate: 'CLASSIC',
    // Carousel photos already uploaded to the server: [{ key, previewUrl }] in slide order.
    telegramImages: [],
  });

  const loadAll = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError('');
    try {
      const [adsRes, listingsRes, pricingRes] = await Promise.all([
        api.get('/ads/mine'),
        api.get('/listings', { params: { sellerId: user.id, limit: 50 } }),
        api.get('/ads/pricing'),
      ]);
      setAds(adsRes.data?.ads || []);
      setMyListings((listingsRes.data?.listings || []).filter((l) => l.status === 'ACTIVE'));
      setDailyRates(pricingRes.data?.dailyRatesEtb || {});
      setTemplateMultipliers(pricingRes.data?.bannerTemplateMultipliers || {});
      setMaxCampaignDays(Number(pricingRes.data?.maxCampaignDays || 90));
      setCarouselLimits({ ...DEFAULT_CAROUSEL_LIMITS, ...(pricingRes.data?.telegramCarousel || {}) });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your advertising campaigns');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    let cancelled = false;
    async function loadAnalytics() {
      const candidates = ads.filter((ad) => ['PUBLISHED', 'ACTIVE', 'SCHEDULED'].includes(ad.status)).slice(0, 20);
      const pairs = await Promise.all(candidates.map(async (ad) => {
        try {
          const { data } = await api.get(`/ads/${ad.id}/analytics`);
          return [ad.id, data];
        } catch {
          return [ad.id, null];
        }
      }));
      if (!cancelled) setAnalytics(Object.fromEntries(pairs));
    }
    if (ads.length) loadAnalytics();
    return () => { cancelled = true; };
  }, [ads]);

  const needsListing = LISTING_LINKED_TYPES.includes(form.type);
  const needsCreative = form.type === 'BANNER';
  const needsHeadline = form.type === 'BANNER' || form.type === 'TELEGRAM_PROMOTION';
  const needsTelegramTemplate = form.type === 'TELEGRAM_PROMOTION';
  const needsCarouselImages = needsTelegramTemplate && form.telegramTemplate === 'CAROUSEL';
  const carouselCount = form.telegramImages.length;
  const days = campaignDays(form.startDate, form.endDate);
  const templateMultiplier = form.type === 'BANNER' ? (templateMultipliers[form.bannerTemplate] || 1) : 1;
  const estimatedPrice = days > 0 && dailyRates[form.type] ? days * dailyRates[form.type] * templateMultiplier : null;

  const activityItems = ads.map((ad) => ({
    id: `ad-${ad.id}`,
    icon: '📣',
    text: `${AD_TYPES.find((t) => t.value === ad.type)?.label || 'Campaign'} ${STATUS_LABELS[ad.status] || ad.status}`,
    time: ad.updatedAt || ad.createdAt,
    href: ad.listing?.id ? `/listings/${ad.listing.id}` : undefined,
  }));

  function clearMessages() {
    setError('');
    setSuccess('');
  }

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
      setForm((f) => ({ ...f, creativeImageKey: data.key, creativePreviewUrl: data.previewUrl || URL.createObjectURL(file) }));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not upload banner image');
    } finally {
      setUploadingCreative(false);
    }
  }

  // Upload one or many photos in a single request and append them to the
  // carousel, in the order the files were selected.
  async function handleCarouselSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    clearMessages();

    const { maxImages, maxFileBytes } = carouselLimits;
    const room = maxImages - carouselCount;
    if (room <= 0) return setError(`A carousel can hold at most ${maxImages} photos. Remove one to add another.`);

    const tooBig = files.find((f) => f.size > maxFileBytes);
    if (tooBig) return setError(`"${tooBig.name}" is larger than ${Math.round((maxFileBytes / (1024 * 1024)) * 10) / 10} MB.`);

    const accepted = files.slice(0, room);
    setUploadingCarousel(true);
    try {
      const body = new FormData();
      accepted.forEach((file) => body.append('files', file));
      const { data } = await api.post('/ads/telegram-images', body);
      const added = (data?.images || []).map((img) => ({ key: img.key, previewUrl: img.previewUrl }));
      setForm((f) => ({ ...f, telegramImages: [...f.telegramImages, ...added].slice(0, maxImages) }));
      if (files.length > accepted.length) {
        setError(`Only the first ${accepted.length} photo${accepted.length === 1 ? ' was' : 's were'} added — a carousel holds at most ${maxImages}.`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not upload carousel photos');
    } finally {
      setUploadingCarousel(false);
    }
  }

  function removeCarouselImage(index) {
    setForm((f) => ({ ...f, telegramImages: f.telegramImages.filter((_, i) => i !== index) }));
  }

  function moveCarouselImage(index, delta) {
    setForm((f) => {
      const target = index + delta;
      if (target < 0 || target >= f.telegramImages.length) return f;
      const next = [...f.telegramImages];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...f, telegramImages: next };
    });
  }

  async function submitAd(e) {
    e.preventDefault();
    clearMessages();
    if (needsListing && !form.listingId) return setError('Select an active listing for this campaign type.');
    if (needsHeadline && !form.headline.trim()) return setError('Enter the campaign headline/message.');
    if (needsCreative && !form.creativeImageKey) return setError('Upload the banner image first.');
    if (needsCarouselImages && carouselCount < carouselLimits.minImages) return setError(`Add at least ${carouselLimits.minImages} photos to build a carousel.`);
    if (days <= 0) return setError('Choose a valid campaign date range.');
    if (days > maxCampaignDays) return setError(`Campaigns can run for at most ${maxCampaignDays} days.`);

    setSubmitting(true);
    try {
      const { data } = await api.post('/ads', {
        type: form.type,
        listingId: needsListing ? form.listingId : undefined,
        startDate: new Date(`${form.startDate}T00:00:00`).toISOString(),
        endDate: new Date(`${form.endDate}T00:00:00`).toISOString(),
        headline: form.headline || undefined,
        linkUrl: form.linkUrl || undefined,
        creativeImageKey: needsCreative ? form.creativeImageKey : undefined,
        bannerTemplate: needsCreative ? form.bannerTemplate : undefined,
        telegramTemplate: needsTelegramTemplate ? form.telegramTemplate : undefined,
        telegramImageKeys: needsCarouselImages ? form.telegramImages.map((img) => img.key) : undefined,
      });
      setSuccess(`Campaign ${data.ad.campaignReference} created. The server fixed the price at ${Number(data.ad.priceQuoted).toLocaleString()} ETB.`);
      setForm((f) => ({ ...f, listingId: '', headline: '', linkUrl: '', creativeImageKey: '', creativePreviewUrl: '', bannerTemplate: 'CLASSIC', telegramTemplate: 'CLASSIC', telegramImages: [] }));
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
      await startChapaPayment({ type: 'ADVERTISING', advertisementId: ad.id, amount: Number(ad.priceQuoted || ad.amountDue), method: payMethod });
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not start payment');
      setPayingId(null);
    }
  }

  async function cancelAd(ad) {
    clearMessages();
    if (!window.confirm('Cancel this campaign? This cannot be undone.')) return;
    setPayingId(ad.id);
    try {
      await api.patch(`/ads/${ad.id}/cancel`, {});
      setSuccess('Campaign cancelled.');
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not cancel campaign');
    } finally {
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

  const liveCount = useMemo(() => ads.filter((a) => ['PUBLISHED', 'ACTIVE'].includes(a.status)).length, [ads]);

  if (loading && ads.length === 0) {
    return <main className="section"><div className="container-wide loading">Loading advertising center…</div></main>;
  }

  return (
    <main className="section">
      <div className="container-wide">
        <DashboardWelcome user={user} subtitle="Promote your listing or run a moderated platform campaign." />
        <div className="page-header">
          <div>
            <span className="eyebrow">ADVERTISING CENTER</span>
            <h1>Promote on MarketBridge.</h1>
            <p>Advertising is a capability available to every signed-in user; no permanent advertiser role is required.</p>
          </div>
        </div>

        <RecentActivity items={activityItems} emptyText="No campaigns yet — create one below." />
        {error && <div className="alert error">{error}</div>}
        {success && <div className="alert">{success}</div>}

        <div className="admin-grid">
          <div className="card">
            <h2>New campaign</h2>
            <form onSubmit={submitAd}>
              <label>Campaign type</label>
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, listingId: '', headline: '', creativeImageKey: '', creativePreviewUrl: '', bannerTemplate: 'CLASSIC', telegramTemplate: 'CLASSIC', telegramImages: [] }))}>
                {AD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <p className="muted">{AD_TYPES.find((t) => t.value === form.type)?.help}</p>

              {needsListing && (
                <>
                  <label>Active listing</label>
                  <select value={form.listingId} onChange={(e) => setForm((f) => ({ ...f, listingId: e.target.value }))} required>
                    <option value="">Select one of your active listings…</option>
                    {myListings.map((l) => <option key={l.id} value={l.id}>{l.title || l.cropType || l.id.slice(0, 8)}</option>)}
                  </select>
                  {myListings.length === 0 && <p className="muted">Create an active listing first.</p>}
                </>
              )}

              {needsTelegramTemplate && (
                <>
                  <label>Promotion style</label>
                  <p className="muted" style={{ marginTop: -6 }}>Pick a style to load a ready-made message below — edit it however you like afterward.</p>
                  <div className="tg-template-picker">
                    {TELEGRAM_TEMPLATE_OPTIONS.map((tpl) => (
                      <button
                        type="button"
                        key={tpl.value}
                        className={`tg-template-option${form.telegramTemplate === tpl.value ? ' tg-template-option--active' : ''}`}
                        onClick={() => setForm((f) => ({ ...f, telegramTemplate: tpl.value, headline: tpl.starter }))}
                      >
                        <span className={`tg-bubble tg-bubble--${tpl.value.toLowerCase()} ${tpl.anim}`} aria-hidden="true">
                          <span className="tg-bubble-icon">{tpl.icon}</span>
                        </span>
                        <strong>{tpl.label}</strong>
                        <span className="muted" style={{ fontSize: 12 }}>{tpl.help}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {needsHeadline && (
                <>
                  <label>{form.type === 'TELEGRAM_PROMOTION' ? 'Promotion message' : 'Banner headline'}</label>
                  <input value={form.headline} onChange={(e) => setForm((f) => ({ ...f, headline: e.target.value }))} maxLength={140} required placeholder={form.type === 'TELEGRAM_PROMOTION' ? 'What should MarketBridge post?' : 'What the banner says'} />
                </>
              )}

              {needsCarouselImages && (
                <>
                  <label>Carousel photos</label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    onChange={handleCarouselSelect}
                    disabled={uploadingCarousel || carouselCount >= carouselLimits.maxImages}
                  />
                  <p className="muted">
                    Select {carouselLimits.minImages}–{carouselLimits.maxImages} photos at once or add them in batches. JPEG, PNG, or WebP, up to {Math.round((carouselLimits.maxFileBytes / (1024 * 1024)) * 10) / 10} MB each. Photos stay private until the campaign is approved.
                  </p>
                  {uploadingCarousel && <p className="muted">Uploading securely…</p>}

                  {carouselCount > 0 && (
                    <>
                      <p className="muted" style={{ marginBottom: 6 }}>
                        <strong>{carouselCount} of {carouselLimits.maxImages} photos</strong>
                        {carouselCount < carouselLimits.minImages ? ` — add ${carouselLimits.minImages - carouselCount} more to continue.` : ' — swipe order matches the order below.'}
                      </p>
                      <ul className="tg-carousel-thumbs">
                        {form.telegramImages.map((img, i) => (
                          <li className="tg-carousel-thumb" key={img.key}>
                            <img src={img.previewUrl} alt={`Carousel photo ${i + 1}`} />
                            <span className="tg-carousel-thumb-index">{i + 1}</span>
                            <div className="tg-carousel-thumb-actions">
                              <button type="button" onClick={() => moveCarouselImage(i, -1)} disabled={i === 0} aria-label={`Move photo ${i + 1} earlier`}>←</button>
                              <button type="button" onClick={() => moveCarouselImage(i, 1)} disabled={i === carouselCount - 1} aria-label={`Move photo ${i + 1} later`}>→</button>
                              <button type="button" onClick={() => removeCarouselImage(i)} aria-label={`Remove photo ${i + 1}`}>×</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <label>Preview</label>
                      <ImageCarousel images={form.telegramImages.map((img) => img.previewUrl)} alt="Carousel photo" />
                    </>
                  )}
                </>
              )}

              {needsCreative && (
                <>
                  <label>Banner image</label>
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleCreativeSelect} disabled={uploadingCreative} />
                  <p className="muted">JPEG, PNG, or WebP. Maximum 5 MB. Creative is private until the campaign is approved.</p>
                  {form.creativePreviewUrl && <div className="media-preview-grid"><div className="media-preview-item"><img src={form.creativePreviewUrl} alt="Banner preview" /></div></div>}
                  {uploadingCreative && <p className="muted">Uploading securely…</p>}

                  <label>Banner style</label>
                  <div className="ad-template-picker">
                    {BANNER_TEMPLATE_OPTIONS.map((tpl) => {
                      const multiplier = templateMultipliers[tpl.value] || 1;
                      return (
                        <button
                          type="button"
                          key={tpl.value}
                          className={`ad-template-option${form.bannerTemplate === tpl.value ? ' ad-template-option--active' : ''}`}
                          onClick={() => setForm((f) => ({ ...f, bannerTemplate: tpl.value }))}
                        >
                          <span className={`ad-template-swatch ad-template-swatch--${tpl.value.toLowerCase()}`} aria-hidden="true" />
                          <strong>{tpl.label}</strong>
                          <span className="muted" style={{ fontSize: 12 }}>{tpl.help}</span>
                          <span className="muted" style={{ fontSize: 12 }}>{multiplier > 1 ? `+${Math.round((multiplier - 1) * 100)}% rate` : 'Standard rate'}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              <label>Destination link (optional)</label>
              <input value={form.linkUrl} onChange={(e) => setForm((f) => ({ ...f, linkUrl: e.target.value }))} placeholder="https://example.com or /listings/..." maxLength={2000} />
              <p className="muted">Only HTTPS external URLs or safe internal paths are accepted.</p>

              <label>Start date</label>
              <input type="date" value={form.startDate} min={todayPlus(0)} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} required />
              <label>End date</label>
              <input type="date" value={form.endDate} min={form.startDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} required />

              <div className="sd-panel" style={{ marginTop: 14 }}>
                <strong>Server pricing</strong>
                <p className="muted" style={{ marginBottom: 0 }}>
                  {estimatedPrice != null
                    ? `${estimatedPrice.toLocaleString()} ETB estimated for ${days} day${days === 1 ? '' : 's'} at ${Number(dailyRates[form.type] || 0).toLocaleString()} ETB/day${templateMultiplier > 1 ? ` (${BANNER_TEMPLATE_OPTIONS.find((t) => t.value === form.bannerTemplate)?.label} style: +${Math.round((templateMultiplier - 1) * 100)}%)` : ''}.`
                    : 'Choose dates to see the current rate.'}
                </p>
                <small className="muted">Final amount is recalculated and fixed by the backend when you submit.</small>
              </div>

              <div className="sd-modal-actions" style={{ marginTop: 20 }}>
                <button className="btn btn-primary" type="submit" disabled={submitting || uploadingCreative || uploadingCarousel}>{submitting ? 'Creating…' : 'Create campaign'}</button>
              </div>
            </form>
          </div>

          <div className="card">
            <h2>Campaign lifecycle</h2>
            <p className="muted"><strong>1. Create:</strong> MarketBridge validates the listing, creative, URL, dates and calculates the price.</p>
            <p className="muted"><strong>2. Pay:</strong> Chapa payment must equal the server quote exactly.</p>
            <p className="muted"><strong>3. Publish:</strong> Featured/Top/Search campaigns schedule or publish after payment. Banner and Telegram remain <strong>Paid — pending review</strong>.</p>
            <p className="muted"><strong>4. Review:</strong> Admin approves or rejects banner/Telegram content.</p>
            <p className="muted"><strong>5. Expire:</strong> Campaigns stop serving automatically at endDate even if no cleanup job runs.</p>
            <p className="muted"><strong>Live campaigns:</strong> {liveCount}</p>
          </div>
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <h2>My campaigns</h2>
            <button type="button" className="btn btn-light" onClick={loadAll} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          </div>

          {ads.length === 0 && <p className="muted">You haven't created any campaigns yet.</p>}
          <div className="sd-flow">
            {ads.map((ad) => {
              const pending = (ad.payments || []).find((p) => p.status === 'PENDING');
              const paid = (ad.payments || []).find((p) => p.status === 'PAID');
              const stats = analytics[ad.id];
              const amountDue = Number(ad.priceQuoted || ad.amountDue || 0);
              return (
                <div className="sd-panel" key={ad.id}>
                  {ad.creativeImageUrl && <img src={ad.creativeImageUrl} alt={ad.headline || 'Campaign creative'} loading="lazy" decoding="async" style={{ width: '100%', borderRadius: 10, marginBottom: 10, maxHeight: 180, objectFit: 'cover' }} />}
                  {ad.type === 'TELEGRAM_PROMOTION' && ad.telegramImageUrls?.length > 0 && <ImageCarousel images={ad.telegramImageUrls} alt={ad.headline || 'Carousel photo'} className="img-carousel--compact" />}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h3>{AD_TYPES.find((t) => t.value === ad.type)?.label || ad.type}</h3>
                    <span className={statusClass(ad.status)}>{STATUS_LABELS[ad.status] || ad.status}</span>
                  </div>
                  <p className="muted"><strong>Reference:</strong> {ad.campaignReference || ad.id}</p>
                  {ad.headline && <p className="muted">{ad.headline}</p>}
                  {ad.type === 'BANNER' && <p className="muted"><strong>Style:</strong> {BANNER_TEMPLATE_OPTIONS.find((t) => t.value === ad.bannerTemplate)?.label || 'Classic'}</p>}
                  {ad.type === 'TELEGRAM_PROMOTION' && <p className="muted"><strong>Style:</strong> {TELEGRAM_TEMPLATE_OPTIONS.find((t) => t.value === ad.telegramTemplate)?.label || 'Classic'}</p>}
                  <p className="muted">{ad.listing ? `Listing: ${ad.listing.title || ad.listing.cropType}` : 'Platform-wide placement'}</p>
                  <p className="muted">{new Date(ad.startDate).toLocaleDateString()} — {new Date(ad.endDate).toLocaleDateString()}</p>
                  <p className="muted"><strong>Quoted:</strong> {amountDue.toLocaleString()} {ad.currency || 'ETB'} · <strong>Paid:</strong> {paid ? Number(ad.amountPaid || paid.amount || 0).toLocaleString() : '0'} {ad.currency || 'ETB'}</p>
                  {stats && <p className="muted"><strong>Performance:</strong> {stats.impressions} impressions · {stats.clicks} clicks · {stats.ctr}% CTR</p>}
                  {ad.rejectionReason && <p className="alert error">Rejected: {ad.rejectionReason}</p>}

                  {!paid && pending && (
                    <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 auto' }}>
                        <p className="muted" style={{ marginBottom: 6 }}>Payment is still pending.</p>
                        <button type="button" className="sd-btn sd-btn-primary" disabled={payingId === ad.id} onClick={() => resumeAdPayment(pending.id, ad.id)}>{payingId === ad.id ? 'Redirecting…' : 'Resume payment'}</button>
                      </div>
                      <button type="button" className="sd-btn sd-btn-outline" disabled={payingId === ad.id} onClick={() => cancelAd(ad)}>Cancel campaign</button>
                    </div>
                  )}
                  {!paid && !pending && ad.status === 'PENDING_PAYMENT' && (
                    <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} style={{ maxWidth: 200 }}>
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      <button type="button" className="sd-btn sd-btn-primary" disabled={payingId === ad.id} onClick={() => payForAd(ad)}>{payingId === ad.id ? 'Redirecting…' : `Pay ${amountDue.toLocaleString()} ETB`}</button>
                      <button type="button" className="sd-btn sd-btn-outline" disabled={payingId === ad.id} onClick={() => cancelAd(ad)}>Cancel campaign</button>
                    </div>
                  )}
                  {ad.status === 'PAID_PENDING_REVIEW' && <p className="muted" style={{ marginTop: 10 }}><strong>Paid.</strong> Waiting for MarketBridge content review.</p>}
                  {ad.type === 'TELEGRAM_PROMOTION' && ['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(ad.status) && <p className="muted">Telegram publication is handled manually by MarketBridge.</p>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
