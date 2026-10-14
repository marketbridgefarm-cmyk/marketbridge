import React from 'react';

// Modal: register a new truck.
export default function TruckRegistrationModal({ truckForm, setTruckForm, actionLoading, setShowTruckModal, registerTruck }) {
  return (
    <div
      className="sd-report-backdrop"
      role="presentation"
      onClick={() => setShowTruckModal(false)}
    >
      <div
        className="sd-report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="truck-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sd-report-header">
          <h2 id="truck-modal-title">Register a truck</h2>
          <button
            type="button"
            className="btn btn-light btn-sm"
            aria-label="Close registration form"
            onClick={() => setShowTruckModal(false)}
            disabled={actionLoading === 'register-truck'}
          >
            Close
          </button>
        </div>

        <p className="muted small">
          Register a truck so buyers and sellers can request it for transport jobs.
        </p>

        <form onSubmit={registerTruck}>
          <div className="sd-form-grid">
            <div>
              <label htmlFor="registration">Registration plate</label>
              <input
                id="registration"
                required
                value={truckForm.registration}
                onChange={(e) =>
                  setTruckForm({ ...truckForm, registration: e.target.value })
                }
                placeholder="e.g. ET-12345"
              />
            </div>

            <div>
              <label htmlFor="truckType">Truck type</label>
              <input
                id="truckType"
                required
                value={truckForm.truckType}
                onChange={(e) =>
                  setTruckForm({ ...truckForm, truckType: e.target.value })
                }
                placeholder="e.g. Flatbed, Isuzu, FSR"
              />
            </div>

            <div>
              <label htmlFor="capacity">Capacity (tons)</label>
              <input
                id="capacity"
                required
                min="0.1"
                step="0.1"
                type="number"
                value={truckForm.capacity}
                onChange={(e) =>
                  setTruckForm({ ...truckForm, capacity: e.target.value })
                }
                placeholder="e.g. 18"
              />
            </div>

            <div>
              <label htmlFor="operatingArea">Operating area / routes</label>
              <input
                id="operatingArea"
                value={truckForm.operatingArea}
                onChange={(e) =>
                  setTruckForm({ ...truckForm, operatingArea: e.target.value })
                }
                placeholder="e.g. Addis Ababa – Jimma"
              />
            </div>
          </div>

          <div className="sd-modal-actions sd-report-actions">
            <button
              type="button"
              className="sd-btn sd-btn-outline"
              onClick={() => setShowTruckModal(false)}
              disabled={actionLoading === 'register-truck'}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="sd-btn sd-btn-primary"
              disabled={actionLoading === 'register-truck'}
            >
              {actionLoading === 'register-truck' ? 'Registering…' : 'Register truck'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
