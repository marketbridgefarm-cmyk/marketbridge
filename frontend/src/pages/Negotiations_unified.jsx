import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

// ============================================================================
// NEGOTIATIONS HUB
// ============================================================================
//
// This page is the single action center for the three negotiation systems
// already implemented by the backend:
//
//   1. Produce/listing offers:
//      Offer -> BUYER / SELLER
//      ACCEPT / REJECT / COUNTER / ACCEPT_COUNTER / RE_COUNTER
//
//   2. Transport quotes:
//      TransportQuote -> REQUESTER / PROVIDER
//      ACCEPT / REJECT / COUNTER
//
//   3. Inspection quotes:
//      InspectionQuote -> REQUESTER / PROVIDER
//      ACCEPT / REJECT / COUNTER
//
// No backend changes are required. The page assembles the existing endpoints
// and keeps each system's existing role/turn rules intact.
// ============================================================================

const SELLER_LISTING_STATUSES = ['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'];

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'produce', label: 'Produce' },
  { id: 'transport', label: 'Transport' },
  { id: 'inspection', label: 'Inspection' },
];

function numericAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatETB(value) {
  const n = numericAmount(value);
  return n == null ? '—' : `${n.toLocaleString()} ETB`;
}

function latestAmount(item) {
  if (item.status === 'COUNTERED' && item.counterAmount != null) {
    return numericAmount(item.counterAmount);
  }
  return numericAmount(item.amount);
}

function leafItems(items, parentField) {
  const list = Array.isArray(items) ? items : [];
  const parentIds = new Set(
    list.map((item) => item[parentField]).filter(Boolean)
  );

  return list.filter((item) => !parentIds.has(item.id));
}

function sortNewest(items) {
  return [...items].sort(
    (a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) -
      new Date(a.updatedAt || a.createdAt || 0)
  );
}

function dedupeById(items) {
  const map = new Map();
  for (const item of items) {
    if (item?.id) map.set(item.id, item);
  }
  return [...map.values()];
}

function isArrangingParty(job, order, userId) {
  if (!job || !order || !userId) return false;

  if (job.arrangingParty === 'SELLER') {
    return order.sellerId === userId;
  }

  if (job.arrangingParty === 'BUYER') {
    return order.buyerId === userId;
  }

  if (job.arrangingParty === 'JOINT') {
    return order.buyerId === userId || order.sellerId === userId;
  }

  return false;
}

function quoteTurn(quote) {
  if (quote.status === 'PENDING') return 'REQUESTER';

  if (quote.status === 'COUNTERED') {
    return quote.counteredBy === 'REQUESTER'
      ? 'PROVIDER'
      : 'REQUESTER';
  }

  return null;
}

function quoteExpired(quote) {
  return Boolean(
    quote?.expiresAt &&
      new Date(quote.expiresAt).getTime() <= Date.now()
  );
}

function listingTitle(listing) {
  return (
    listing?.title ||
    listing?.cropType ||
    'Agricultural listing'
  );
}

export default function Negotiations() {
  const { user } = useAuth();

  const [produceOffers, setProduceOffers] = useState([]);
  const [transportQuotes, setTransportQuotes] = useState([]);
  const [inspectionQuotes, setInspectionQuotes] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [busyKey, setBusyKey] = useState('');
  const [counterDrafts, setCounterDrafts] = useState({});
  const [toastMsg, setToastMsg] = useState('');

  const toast = useCallback((message) => {
    setToastMsg(message);
    window.setTimeout(() => setToastMsg(''), 2800);
  }, []);

  const loadAll = useCallback(async () => {
    if (!user?.id) return;

    setLoading(true);
    setError('');

    try {
      const sellerListingRequests = SELLER_LISTING_STATUSES.map((status) =>
        api.get('/listings', {
          params: {
            sellerId: user.id,
            status,
          },
        })
      );

      const requests = [
        api.get('/offers/mine'),
        api.get('/orders'),
        ...sellerListingRequests,
      ];

      // Transport provider negotiations are exposed through the existing
      // /open and /mine endpoints. They are only requested for truck owners.
      if (user.roles?.includes('TRUCK_OWNER')) {
        requests.push(api.get('/transport/open'));
        requests.push(api.get('/transport/mine'));
      }

      // Inspection provider negotiations are exposed through /available,
      // where an inspector sees only their own quote on each request.
      if (user.roles?.includes('INSPECTOR')) {
        requests.push(api.get('/inspections/available'));
      }

      const results = await Promise.allSettled(requests);

      const valueAt = (index) =>
        results[index]?.status === 'fulfilled'
          ? results[index].value?.data
          : null;

      const buyerOffers = (valueAt(0)?.offers || []).map((offer) => ({
        ...offer,
        viewerRole: 'BUYER',
        negotiationType: 'produce',
      }));

      const orders = valueAt(1)?.orders || [];

      const sellerListings = results
        .slice(2, 2 + SELLER_LISTING_STATUSES.length)
        .flatMap((result) =>
          result.status === 'fulfilled'
            ? result.value?.data?.listings || []
            : []
        );

      const uniqueListings = dedupeById(sellerListings);

      const sellerOfferResults = await Promise.allSettled(
        uniqueListings.map((listing) =>
          api.get(`/offers/listing/${listing.id}`)
        )
      );

      const sellerOffers = uniqueListings.flatMap((listing, index) => {
        const result = sellerOfferResults[index];
        if (result?.status !== 'fulfilled') return [];

        return (result.value?.data?.offers || []).map((offer) => ({
          ...offer,
          listing,
          viewerRole: 'SELLER',
          negotiationType: 'produce',
        }));
      });

      const produce = dedupeById([
        ...buyerOffers,
        ...sellerOffers,
      ]);

      // ----------------------------------------------------------------------
      // Transport quotes
      // ----------------------------------------------------------------------
      //
      // Requester side:
      //   /orders already contains each participant's transport job and all
      //   quotes for that job.
      //
      // Provider side:
      //   /transport/open contains the provider's own quotes before a job is
      //   assigned; /transport/mine contains their assigned jobs afterwards.
      //
      // Combining both lets the hub show the same negotiation from either
      // side without adding a new backend endpoint.
      // ----------------------------------------------------------------------

      const transportFromOrders = [];

      for (const order of orders) {
        const job = order.transportJob;
        if (!job || !isArrangingParty(job, order, user.id)) continue;

        for (const quote of job.quotes || []) {
          transportFromOrders.push({
            ...quote,
            job,
            order,
            viewerRole: 'REQUESTER',
            negotiationType: 'transport',
          });
        }
      }

      let transportProviderItems = [];

      if (user.roles?.includes('TRUCK_OWNER')) {
        const openIndex =
          2 + SELLER_LISTING_STATUSES.length;
        const mineIndex = openIndex + 1;

        const openJobs =
          valueAt(openIndex)?.jobs || [];
        const mineJobs =
          valueAt(mineIndex)?.jobs || [];

        const providerJobs = dedupeById([
          ...openJobs,
          ...mineJobs,
        ]);

        transportProviderItems = providerJobs.flatMap((job) =>
          (job.quotes || [])
            .filter((quote) => quote.truckOwnerId === user.id)
            .map((quote) => ({
              ...quote,
              job,
              order: job.order,
              viewerRole: 'PROVIDER',
              negotiationType: 'transport',
            }))
        );
      }

      setTransportQuotes(
        dedupeById([
          ...transportFromOrders,
          ...transportProviderItems,
        ])
      );

      // ----------------------------------------------------------------------
      // Inspection quotes
      // ----------------------------------------------------------------------
      //
      // Requester side:
      //   /orders contains inspectionRequests and their active quote threads.
      //
      // Provider side:
      //   /inspections/available exposes only the inspector's own quotes,
      //   preserving the backend's sealed-bid rule.
      // ----------------------------------------------------------------------

      const inspectionFromOrders = [];
      const requesterInspectionRequests = orders.flatMap((order) =>
        (order.inspectionRequests || [])
          .filter((request) => request.requestedById === user.id)
          .map((request) => ({ order, request }))
      );

      // The order endpoint intentionally exposes only active inspection
      // quotes. For the requester we can use the existing quote-list endpoint
      // to recover the complete thread/history without exposing it to anyone
      // who is not the requester.
      const inspectionQuoteResults = await Promise.allSettled(
        requesterInspectionRequests.map(({ request }) =>
          api.get(`/inspections/${request.id}/quotes`)
        )
      );

      requesterInspectionRequests.forEach(({ order, request }, index) => {
        const result = inspectionQuoteResults[index];
        const fullQuotes =
          result?.status === 'fulfilled'
            ? result.value?.data?.quotes || []
            : request.quotes || [];

        for (const quote of fullQuotes) {
          inspectionFromOrders.push({
            ...quote,
            request,
            order,
            viewerRole: 'REQUESTER',
            negotiationType: 'inspection',
          });
        }

        // An accepted inspection may have its accepted quote hidden by the
        // order's active-quote filter if the dedicated quote lookup failed.
        // Keep a summary row only when there is no concrete quote to show.
        if (
          request.status === 'ACCEPTED' &&
          request.inspectorId &&
          !fullQuotes.some(
            (quote) => quote.status === 'ACCEPTED'
          )
        ) {
          inspectionFromOrders.push({
            id: `accepted-inspection-${request.id}`,
            synthetic: true,
            request,
            order,
            amount: request.fee,
            status: 'ACCEPTED',
            viewerRole: 'REQUESTER',
            negotiationType: 'inspection',
          });
        }
      });

      let inspectionProviderItems = [];

      if (user.roles?.includes('INSPECTOR')) {
        const availableIndex =
          2 +
          SELLER_LISTING_STATUSES.length +
          (user.roles?.includes('TRUCK_OWNER') ? 2 : 0);

        const availableRequests =
          valueAt(availableIndex)?.requests || [];

        inspectionProviderItems = availableRequests.flatMap((request) =>
          (request.quotes || [])
            .filter((quote) => quote.inspectorId === user.id)
            .map((quote) => ({
              ...quote,
              request,
              order: null,
              viewerRole: 'PROVIDER',
              negotiationType: 'inspection',
            }))
        );
      }

      setInspectionQuotes(
        dedupeById([
          ...inspectionFromOrders,
          ...inspectionProviderItems,
        ])
      );

      setProduceOffers(produce);
    } catch (err) {
      console.error('Negotiations load error:', err);
      setError(
        err?.response?.data?.error ||
          'Could not load negotiations'
      );
    } finally {
      setLoading(false);
    }
  }, [user?.id, user?.roles]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // --------------------------------------------------------------------------
  // Action helpers
  // --------------------------------------------------------------------------

  const updateDraft = useCallback((id, value) => {
    setCounterDrafts((previous) => ({
      ...previous,
      [id]: value,
    }));
  }, []);

  const respondProduce = useCallback(
    async (offer, action) => {
      const key = `produce:${offer.id}:${action}`;
      const counterAmount = Number(counterDrafts[offer.id]);

      if (
        (action === 'COUNTER' || action === 'RE_COUNTER') &&
        (!Number.isFinite(counterAmount) || counterAmount <= 0)
      ) {
        toast('Enter a valid positive counter-offer amount.');
        return;
      }

      setBusyKey(key);

      try {
        const payload = { action };

        if (
          action === 'COUNTER' ||
          action === 'RE_COUNTER'
        ) {
          payload.counterAmount = counterAmount;
        }

        const response = await api.patch(
          `/offers/${offer.id}`,
          payload
        );

        toast(
          response.data?.message ||
            'Negotiation updated.'
        );

        setCounterDrafts((previous) => ({
          ...previous,
          [offer.id]: '',
        }));

        await loadAll();
      } catch (err) {
        toast(
          err?.response?.data?.error ||
            'Could not update the offer.'
        );
      } finally {
        setBusyKey('');
      }
    },
    [counterDrafts, loadAll, toast]
  );

  const respondTransport = useCallback(
    async (quote, action) => {
      const key = `transport:${quote.id}:${action}`;
      const counterAmount = Number(counterDrafts[quote.id]);

      if (
        action === 'COUNTER' &&
        (!Number.isFinite(counterAmount) || counterAmount <= 0)
      ) {
        toast('Enter a valid positive counter-offer amount.');
        return;
      }

      setBusyKey(key);

      try {
        const payload = { action };

        if (action === 'COUNTER') {
          payload.counterAmount = counterAmount;
        }

        const response = await api.patch(
          `/transport/quotes/${quote.id}`,
          payload
        );

        toast(
          response.data?.message ||
            'Transport negotiation updated.'
        );

        setCounterDrafts((previous) => ({
          ...previous,
          [quote.id]: '',
        }));

        await loadAll();
      } catch (err) {
        toast(
          err?.response?.data?.error ||
            'Could not update the transport quote.'
        );
      } finally {
        setBusyKey('');
      }
    },
    [counterDrafts, loadAll, toast]
  );

  const respondInspection = useCallback(
    async (quote, action) => {
      if (quote.synthetic) return;

      const key = `inspection:${quote.id}:${action}`;
      const counterAmount = Number(counterDrafts[quote.id]);

      if (
        action === 'COUNTER' &&
        (!Number.isFinite(counterAmount) || counterAmount <= 0)
      ) {
        toast('Enter a valid positive counter-offer amount.');
        return;
      }

      setBusyKey(key);

      try {
        let response;

        if (action === 'COUNTER') {
          response = await api.post(
            `/inspections/${quote.request.id}/quotes/${quote.id}/counter`,
            { counterAmount }
          );
        } else {
          response = await api.patch(
            `/inspections/${quote.request.id}/quotes/${quote.id}/${action === 'ACCEPT' ? 'accept' : 'reject'}`
          );
        }

        toast(
          response.data?.message ||
            'Inspection negotiation updated.'
        );

        setCounterDrafts((previous) => ({
          ...previous,
          [quote.id]: '',
        }));

        await loadAll();
      } catch (err) {
        toast(
          err?.response?.data?.error ||
            'Could not update the inspection quote.'
        );
      } finally {
        setBusyKey('');
      }
    },
    [counterDrafts, loadAll, toast]
  );

  // --------------------------------------------------------------------------
  // Build actionable leaf rows only.
  // --------------------------------------------------------------------------

  const produceLeaves = useMemo(
    () => sortNewest(
      leafItems(produceOffers, 'parentOfferId')
    ),
    [produceOffers]
  );

  const transportLeaves = useMemo(
    () => sortNewest(
      leafItems(transportQuotes, 'parentQuoteId')
    ),
    [transportQuotes]
  );

  const inspectionLeaves = useMemo(
    () => sortNewest(
      leafItems(inspectionQuotes, 'parentQuoteId')
    ),
    [inspectionQuotes]
  );

  const allRows = useMemo(
    () => [
      ...produceLeaves,
      ...transportLeaves,
      ...inspectionLeaves,
    ].sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt || 0) -
        new Date(a.updatedAt || a.createdAt || 0)
    ),
    [
      produceLeaves,
      transportLeaves,
      inspectionLeaves,
    ]
  );

  const visibleRows = useMemo(() => {
    if (filter === 'all') return allRows;
    return allRows.filter(
      (item) => item.negotiationType === filter
    );
  }, [allRows, filter]);

  const counts = useMemo(
    () => ({
      all: allRows.length,
      produce: produceLeaves.length,
      transport: transportLeaves.length,
      inspection: inspectionLeaves.length,
    }),
    [
      allRows.length,
      produceLeaves.length,
      transportLeaves.length,
      inspectionLeaves.length,
    ]
  );

  return (
    <main className="section">
      <div className="container-narrow">
        <span className="eyebrow">NEGOTIATIONS</span>

        <div
          className="row-between"
          style={{
            gap: 16,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1>Your negotiations</h1>
            <p className="lead">
              Manage produce offers, transport quotes, and
              inspection quotes from one place.
            </p>
          </div>

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            onClick={loadAll}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div
          className="sd-tabs"
          style={{
            margin: '20px 0',
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sd-tab ${
                filter === item.id ? 'sd-active' : ''
              }`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span style={{ marginLeft: 6, opacity: 0.7 }}>
                {counts[item.id]}
              </span>
            </button>
          ))}
        </div>

        {error && (
          <div className="alert error">
            {error}
          </div>
        )}

        {loading ? (
          <p>Loading negotiations…</p>
        ) : visibleRows.length === 0 ? (
          <div className="card notice">
            No negotiations found in this section.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gap: 12,
            }}
          >
            {visibleRows.map((item) => (
              <NegotiationRow
                key={`${item.negotiationType}:${item.id}`}
                item={item}
                busyKey={busyKey}
                counterDraft={counterDrafts[item.id] || ''}
                onCounterDraftChange={(value) =>
                  updateDraft(item.id, value)
                }
                onProduceAction={respondProduce}
                onTransportAction={respondTransport}
                onInspectionAction={respondInspection}
              />
            ))}
          </div>
        )}

        {toastMsg && (
          <div className="sd-toast">
            {toastMsg}
          </div>
        )}
      </div>
    </main>
  );
}

function NegotiationRow({
  item,
  busyKey,
  counterDraft,
  onCounterDraftChange,
  onProduceAction,
  onTransportAction,
  onInspectionAction,
}) {
  if (item.negotiationType === 'produce') {
    return (
      <ProduceNegotiationRow
        offer={item}
        busyKey={busyKey}
        counterDraft={counterDraft}
        onCounterDraftChange={onCounterDraftChange}
        onAction={onProduceAction}
      />
    );
  }

  if (item.negotiationType === 'transport') {
    return (
      <TransportNegotiationRow
        quote={item}
        busyKey={busyKey}
        counterDraft={counterDraft}
        onCounterDraftChange={onCounterDraftChange}
        onAction={onTransportAction}
      />
    );
  }

  return (
    <InspectionNegotiationRow
      quote={item}
      busyKey={busyKey}
      counterDraft={counterDraft}
      onCounterDraftChange={onCounterDraftChange}
      onAction={onInspectionAction}
    />
  );
}

// ============================================================================
// PRODUCE / LISTING OFFER
// ============================================================================

function ProduceNegotiationRow({
  offer,
  busyKey,
  counterDraft,
  onCounterDraftChange,
  onAction,
}) {
  const isSeller = offer.viewerRole === 'SELLER';
  const isBuyer = offer.viewerRole === 'BUYER';

  const listingTitle = listingTitleFromOffer(offer);
  const amount = latestAmount(offer);

  // Exact buyer/seller turn rules mirrored from routes/offers.js.
  const sellerCanAct =
    isSeller &&
    (
      offer.status === 'PENDING' ||
      (
        offer.status === 'COUNTERED' &&
        offer.counteredBy === 'BUYER'
      )
    );

  const buyerCanAct =
    isBuyer &&
    offer.status === 'COUNTERED' &&
    offer.counteredBy === 'SELLER';

  const counterValid =
    Number.isFinite(Number(counterDraft)) &&
    Number(counterDraft) > 0;

  const busy = (action) =>
    busyKey === `produce:${offer.id}:${action}`;

  const anyBusy =
    busyKey.startsWith(`produce:${offer.id}:`);

  return (
    <article className="card">
      <div
        className="row-between"
        style={{
          gap: 14,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <span className="role-chip">PRODUCE</span>{' '}
          <span className="role-chip">
            {offer.status}
          </span>{' '}
          <span
            className="role-chip"
            style={{ marginLeft: 6 }}
          >
            {isSeller
              ? 'You are the seller'
              : 'You are the buyer'}
          </span>

          <h3>{listingTitle}</h3>

          <p>
            {formatETB(amount)}
            {offer.quantity
              ? ` · ${offer.quantity} quantity`
              : ''}
          </p>
        </div>

        {offer.listingId && (
          <Link
            className="btn btn-outline"
            to={`/listings/${offer.listingId}`}
          >
            Open listing
          </Link>
        )}
      </div>

      {offer.message && (
        <p className="muted">{offer.message}</p>
      )}

      {offer.status === 'COUNTERED' &&
        offer.counteredBy === 'BUYER' &&
        isSeller && (
          <p className="muted">
            <strong>Buyer countered.</strong>{' '}
            You can accept it, reject the negotiation,
            or send another counter.
          </p>
        )}

      {offer.status === 'COUNTERED' &&
        offer.counteredBy === 'SELLER' &&
        isBuyer && (
          <p className="muted">
            <strong>Seller countered.</strong>{' '}
            You can accept it or send another counter.
          </p>
        )}

      {offer.status === 'COUNTERED' &&
        offer.counteredBy === 'SELLER' &&
        isSeller && (
          <p className="muted">
            You made the latest counter. Waiting for
            the buyer.
          </p>
        )}

      {offer.status === 'COUNTERED' &&
        offer.counteredBy === 'BUYER' &&
        isBuyer && (
          <p className="muted">
            You made the latest counter. Waiting for
            the seller.
          </p>
        )}

      {offer.status === 'PENDING' && isBuyer && (
        <p className="muted">
          Waiting for the seller to respond.
        </p>
      )}

      {offer.status === 'REJECTED' && (
        <p className="muted">
          This negotiation was rejected.
        </p>
      )}

      {offer.status === 'ACCEPTED' && (
        <p className="muted">
          Agreed at <strong>{formatETB(amount)}</strong>.{' '}
          <Link to="/orders">
            View your orders →
          </Link>
        </p>
      )}

      {sellerCanAct && (
        <div
          className="row-actions"
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={anyBusy}
            onClick={() =>
              onAction(offer, 'ACCEPT')
            }
          >
            {busy('ACCEPT')
              ? 'Accepting…'
              : 'Accept'}
          </button>

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={anyBusy}
            onClick={() =>
              onAction(offer, 'REJECT')
            }
          >
            {busy('REJECT')
              ? 'Rejecting…'
              : 'Reject'}
          </button>

          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Counter ETB"
            value={counterDraft}
            disabled={anyBusy}
            onChange={(event) =>
              onCounterDraftChange(
                event.target.value
              )
            }
            style={{ width: 125 }}
          />

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={!counterValid || anyBusy}
            onClick={() =>
              onAction(offer, 'COUNTER')
            }
          >
            {busy('COUNTER')
              ? 'Sending…'
              : 'Counter'}
          </button>
        </div>
      )}

      {buyerCanAct && (
        <div
          className="row-actions"
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={anyBusy}
            onClick={() =>
              onAction(
                offer,
                'ACCEPT_COUNTER'
              )
            }
          >
            {busy('ACCEPT_COUNTER')
              ? 'Accepting…'
              : 'Accept seller counter'}
          </button>

          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Counter ETB"
            value={counterDraft}
            disabled={anyBusy}
            onChange={(event) =>
              onCounterDraftChange(
                event.target.value
              )
            }
            style={{ width: 125 }}
          />

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={!counterValid || anyBusy}
            onClick={() =>
              onAction(
                offer,
                'RE_COUNTER'
              )
            }
          >
            {busy('RE_COUNTER')
              ? 'Sending…'
              : 'Counter seller'}
          </button>
        </div>
      )}
    </article>
  );
}

function listingTitleFromOffer(offer) {
  return (
    offer.listing?.title ||
    offer.listing?.cropType ||
    'Agricultural listing'
  );
}

// ============================================================================
// TRANSPORT QUOTE
// ============================================================================

function TransportNegotiationRow({
  quote,
  busyKey,
  counterDraft,
  onCounterDraftChange,
  onAction,
}) {
  const isRequester =
    quote.viewerRole === 'REQUESTER';
  const isProvider =
    quote.viewerRole === 'PROVIDER';

  const turn = quoteTurn(quote);

  const canAct =
    ['REQUESTER', 'PROVIDER'].includes(turn) &&
    (
      (isRequester && turn === 'REQUESTER') ||
      (isProvider && turn === 'PROVIDER')
    ) &&
    ['PENDING', 'COUNTERED'].includes(
      quote.status
    ) &&
    !quoteExpired(quote);

  const counterValid =
    Number.isFinite(Number(counterDraft)) &&
    Number(counterDraft) > 0;

  const busy = (action) =>
    busyKey === `transport:${quote.id}:${action}`;

  const anyBusy =
    busyKey.startsWith(`transport:${quote.id}:`);

  const job = quote.job;
  const order = quote.order || job?.order;

  const title =
    job?.load ||
    order?.listing?.cropType ||
    order?.listing?.title ||
    'Transport job';

  const roleLabel = isRequester
    ? 'You are the requester'
    : 'You are the transporter';

  return (
    <article className="card">
      <div
        className="row-between"
        style={{
          gap: 14,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <span className="role-chip">
            TRANSPORT
          </span>{' '}
          <span className="role-chip">
            {quote.status}
          </span>{' '}
          <span
            className="role-chip"
            style={{ marginLeft: 6 }}
          >
            {roleLabel}
          </span>

          <h3>{title}</h3>

          <p>
            {formatETB(latestAmount(quote))}
            {job?.destination
              ? ` · ${job.destination}`
              : ''}
          </p>
        </div>

        {order?.id && (
          <Link
            className="btn btn-outline"
            to={`/orders/${order.id}`}
          >
            Open order
          </Link>
        )}
      </div>

      {quote.message && (
        <p className="muted">{quote.message}</p>
      )}

      {quote.status === 'PENDING' && (
        <p className="muted">
          {isRequester
            ? 'The transporter submitted this quote. You can accept, reject, or counter it.'
            : 'Your quote is waiting for the requester to respond.'}
        </p>
      )}

      {quote.status === 'COUNTERED' && (
        <p className="muted">
          {turn === 'REQUESTER'
            ? 'The transporter made the latest counter. The requester must respond.'
            : 'The requester made the latest counter. You can accept or counter it.'}
        </p>
      )}

      {quote.status === 'ACCEPTED' && (
        <p className="muted">
          Transport quote accepted at{' '}
          <strong>
            {formatETB(latestAmount(quote))}
          </strong>.
        </p>
      )}

      {quote.status === 'REJECTED' && (
        <p className="muted">
          This transport negotiation was rejected.
        </p>
      )}

      {quoteExpired(quote) &&
        ['PENDING', 'COUNTERED'].includes(
          quote.status
        ) && (
          <p className="muted">
            This quote has expired and can no longer
            be acted on.
          </p>
        )}

      {canAct && (
        <div
          className="row-actions"
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={anyBusy}
            onClick={() =>
              onAction(quote, 'ACCEPT')
            }
          >
            {busy('ACCEPT')
              ? 'Accepting…'
              : 'Accept'}
          </button>

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={anyBusy}
            onClick={() =>
              onAction(quote, 'REJECT')
            }
          >
            {busy('REJECT')
              ? 'Rejecting…'
              : 'Reject'}
          </button>

          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Counter ETB"
            value={counterDraft}
            disabled={anyBusy}
            onChange={(event) =>
              onCounterDraftChange(
                event.target.value
              )
            }
            style={{ width: 125 }}
          />

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={!counterValid || anyBusy}
            onClick={() =>
              onAction(quote, 'COUNTER')
            }
          >
            {busy('COUNTER')
              ? 'Sending…'
              : 'Counter'}
          </button>
        </div>
      )}
    </article>
  );
}

// ============================================================================
// INSPECTION QUOTE
// ============================================================================

function InspectionNegotiationRow({
  quote,
  busyKey,
  counterDraft,
  onCounterDraftChange,
  onAction,
}) {
  const isRequester =
    quote.viewerRole === 'REQUESTER';
  const isProvider =
    quote.viewerRole === 'PROVIDER';

  const syntheticAccepted = Boolean(
    quote.synthetic
  );

  const turn = quoteTurn(quote);

  const canAct =
    !syntheticAccepted &&
    ['REQUESTER', 'PROVIDER'].includes(turn) &&
    (
      (isRequester && turn === 'REQUESTER') ||
      (isProvider && turn === 'PROVIDER')
    ) &&
    ['PENDING', 'COUNTERED'].includes(
      quote.status
    ) &&
    !quoteExpired(quote);

  const counterValid =
    Number.isFinite(Number(counterDraft)) &&
    Number(counterDraft) > 0;

  const busy = (action) =>
    busyKey === `inspection:${quote.id}:${action}`;

  const anyBusy =
    busyKey.startsWith(`inspection:${quote.id}:`);

  const request = quote.request;
  const order = quote.order;

  const title =
    request?.listing?.cropType ||
    request?.listing?.title ||
    order?.listing?.cropType ||
    order?.listing?.title ||
    'Inspection request';

  const roleLabel = isRequester
    ? 'You are the requester'
    : 'You are the inspector';

  return (
    <article className="card">
      <div
        className="row-between"
        style={{
          gap: 14,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <span className="role-chip">
            INSPECTION
          </span>{' '}
          <span className="role-chip">
            {quote.status}
          </span>{' '}
          <span
            className="role-chip"
            style={{ marginLeft: 6 }}
          >
            {roleLabel}
          </span>

          <h3>{title}</h3>

          <p>
            {formatETB(
              quote.fee != null
                ? quote.fee
                : latestAmount(quote)
            )}
            {request?.location
              ? ` · ${request.location}`
              : ''}
          </p>
        </div>

        {order?.id && (
          <Link
            className="btn btn-outline"
            to={`/orders/${order.id}`}
          >
            Open order
          </Link>
        )}
      </div>

      {syntheticAccepted ? (
        <p className="muted">
          Inspection accepted at{' '}
          <strong>
            {formatETB(request?.fee)}
          </strong>.
          {request?.inspectorId
            ? ' The inspector has been assigned.'
            : ''}
        </p>
      ) : (
        <>
          {quote.message && (
            <p className="muted">
              {quote.message}
            </p>
          )}

          {quote.status === 'PENDING' && (
            <p className="muted">
              {isRequester
                ? 'The inspector submitted this quote. You can accept, reject, or counter it.'
                : 'Your inspection quote is waiting for the requester to respond.'}
            </p>
          )}

          {quote.status === 'COUNTERED' && (
            <p className="muted">
              {turn === 'REQUESTER'
                ? 'The inspector made the latest counter. The requester must respond.'
                : 'The requester made the latest counter. You can accept or counter it.'}
            </p>
          )}

          {quote.status === 'ACCEPTED' && (
            <p className="muted">
              Inspection quote accepted at{' '}
              <strong>
                {formatETB(
                  latestAmount(quote)
                )}
              </strong>.
            </p>
          )}

          {quote.status === 'REJECTED' && (
            <p className="muted">
              This inspection negotiation was rejected.
            </p>
          )}

          {quoteExpired(quote) &&
            ['PENDING', 'COUNTERED'].includes(
              quote.status
            ) && (
              <p className="muted">
                This quote has expired and can no
                longer be acted on.
              </p>
            )}
        </>
      )}

      {canAct && (
        <div
          className="row-actions"
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={anyBusy}
            onClick={() =>
              onAction(quote, 'ACCEPT')
            }
          >
            {busy('ACCEPT')
              ? 'Accepting…'
              : 'Accept'}
          </button>

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={anyBusy}
            onClick={() =>
              onAction(quote, 'REJECT')
            }
          >
            {busy('REJECT')
              ? 'Rejecting…'
              : 'Reject'}
          </button>

          <input
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Counter ETB"
            value={counterDraft}
            disabled={anyBusy}
            onChange={(event) =>
              onCounterDraftChange(
                event.target.value
              )
            }
            style={{ width: 125 }}
          />

          <button
            type="button"
            className="sd-btn sd-btn-outline"
            disabled={!counterValid || anyBusy}
            onClick={() =>
              onAction(quote, 'COUNTER')
            }
          >
            {busy('COUNTER')
              ? 'Sending…'
              : 'Counter'}
          </button>
        </div>
      )}
    </article>
  );
}
