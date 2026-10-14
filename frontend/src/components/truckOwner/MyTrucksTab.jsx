import React from 'react';
import { initialsOf, fmtDate, truckTone, verificationTone } from './truckOwnerHelpers.js';

// "My Trucks" tab: fleet cards and availability controls.
export default function MyTrucksTab({ trucks, actionLoading, setShowTruckModal, setAvailability }) {
  return (
    <div>
      <div className="sd-toolbar">
        <div>
          <span className="sd-eyebrow">FLEET</span>
          <h2>My trucks</h2>
          <p className="sd-muted">
            Manage your fleet and availability.
          </p>
        </div>
        <button
          type="button"
          className="sd-btn sd-btn-primary"
          onClick={() => setShowTruckModal(true)}
        >
          + Register a truck
        </button>
      </div>

      <div className="sd-cards">
        {trucks.map((truck) => {
          const availabilityBusy =
            actionLoading === `availability-${truck.id}`;
          const tone = truckTone(truck.availability);
          const registeredLabel = fmtDate(truck.createdAt);

          return (
            <article className="sd-card sd-truck-card" key={truck.id}>
              {/* Card head — eyebrow + title left, plate + avatar right */}
              <div className="sd-card-head">
                <div className="sd-card-head-text">
                  <span className={`sd-eyebrow tone-${tone}`}>Truck</span>
                  <h3 className="sd-card-title" title={truck.truckType || 'Truck'}>
                    {truck.truckType || 'Truck'}
                  </h3>
                  {truck.operatingArea && (
                    <p className="sd-card-sub">{truck.operatingArea}</p>
                  )}
                </div>

                <div className="sd-card-head-party">
                  <div className="sd-party-info">
                    <span className="sd-party-role">Plate</span>
                    <span className="sd-party-name">{truck.registration}</span>
                  </div>
                  <div className={`sd-avatar tone-${tone}`} aria-hidden="true">
                    {initialsOf(truck.truckType || truck.registration)}
                  </div>
                </div>
              </div>

              <div className="sd-card-body">
                {/* Block 1 — Availability */}
                <section className="sd-card-block">
                  <div className="sd-card-block-title">
                    <h4>Availability</h4>
                    <span className="sd-card-block-note">{truck.capacity}t capacity</span>
                  </div>
                  <div className="sd-card-block-body">
                    <div className="sd-pills">
                      <span className={`sd-pill tone-${tone}`}>
                        <span className="sd-pill-dot" aria-hidden="true" />
                        {truck.availability}
                      </span>
                      {truck.verificationStatus && (
                        <span className={`sd-pill tone-${verificationTone(truck.verificationStatus)}`}>
                          {truck.verificationStatus}
                        </span>
                      )}
                    </div>
                  </div>
                </section>

                {/* Block 2 — Fleet details */}
                <section className="sd-card-block">
                  <div className="sd-card-block-title">
                    <h4>Fleet details</h4>
                  </div>
                  <div className="sd-card-block-body">
                    <div className="sd-facts-row">
                      <div className="sd-fact">
                        <span>Capacity</span>
                        <strong>{truck.capacity}t</strong>
                      </div>
                      <div className="sd-fact">
                        <span>Routes</span>
                        <strong>{truck.operatingArea || 'Any'}</strong>
                      </div>
                    </div>
                  </div>
                </section>

                {registeredLabel && (
                  <p className="sd-card-foot">Registered {registeredLabel}</p>
                )}

                {/* Footer */}
                <div className="sd-card-actions">
                  <button
                    type="button"
                    className="sd-btn sd-btn-outline"
                    disabled={availabilityBusy || truck.availability === 'AVAILABLE'}
                    onClick={() => setAvailability(truck.id, 'AVAILABLE')}
                  >
                    Available
                  </button>
                  <button
                    type="button"
                    className="sd-btn sd-btn-outline"
                    disabled={availabilityBusy || truck.availability === 'BUSY'}
                    onClick={() => setAvailability(truck.id, 'BUSY')}
                  >
                    Busy
                  </button>
                  <button
                    type="button"
                    className="sd-btn sd-btn-outline"
                    disabled={availabilityBusy || truck.availability === 'OFFLINE'}
                    onClick={() => setAvailability(truck.id, 'OFFLINE')}
                  >
                    Offline
                  </button>
                </div>
              </div>
            </article>
          );
        })}

        {trucks.length === 0 && (
          <div className="sd-empty-state">
            <div className="sd-empty-icon" aria-hidden="true">🚛</div>
            <h3>No trucks registered yet</h3>
            <p className="sd-muted">
              Register your first truck to start receiving suitable MarketBridge transport requests.
            </p>
            <button
              type="button"
              className="sd-btn sd-btn-primary"
              onClick={() => setShowTruckModal(true)}
            >
              Register your first truck
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
