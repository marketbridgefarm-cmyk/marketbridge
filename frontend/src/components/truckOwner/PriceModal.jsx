import React from 'react';
import AmountPicker from '../AmountPicker.jsx';

// Modal: select-only price entry for a quote or counter-offer.
export default function PriceModal({ amountModal, setAmountModal, amountDraft, setAmountDraft, submitJobQuote, submitTransportCounter }) {
  return (
    <div
      className="sd-report-backdrop"
      role="presentation"
      onClick={() => setAmountModal(null)}
    >
      <div
        className="sd-report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="amount-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sd-report-header">
          <h2 id="amount-modal-title">
            {amountModal.kind === 'quote'
              ? `Transport quote${amountModal.job?.load ? ` · ${amountModal.job.load}` : ''}`
              : 'Your counter-offer'}
          </h2>
          <button
            type="button"
            className="btn btn-light btn-sm"
            aria-label="Close price picker"
            onClick={() => setAmountModal(null)}
          >
            Close
          </button>
        </div>
        <div className="sd-report-body">
          <p className="sd-amount-note">
            Pick your price from the list. Prices are selected, not typed,
            so every deal stays on MarketBridge.
          </p>
          <AmountPicker
            value={amountDraft}
            onChange={setAmountDraft}
            reference={amountModal.reference}
            min={amountModal.kind === 'quote' ? 100 : 1}
            max={1000000}
            ariaLabel="Price in ETB"
            autoFocus
          />
        </div>
        <div className="sd-modal-actions sd-report-actions">
          <button
            type="button"
            className="sd-btn sd-btn-outline"
            onClick={() => setAmountModal(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={!amountDraft || Number(amountDraft) <= 0}
            onClick={() => {
              const m = amountModal;
              const amount = Number(amountDraft);
              setAmountModal(null);
              if (m.kind === 'quote') submitJobQuote(m.job, amount);
              else submitTransportCounter(m.jobId, m.quoteId, amount);
            }}
          >
            {amountModal.kind === 'quote' ? 'Submit quote' : 'Send counter'}
          </button>
        </div>
      </div>
    </div>
  );
}
