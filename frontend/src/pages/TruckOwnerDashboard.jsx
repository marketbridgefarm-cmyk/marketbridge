import React, { useEffect, useMemo, useState } from 'react';
import api from '../api/client';

const TABS = [
  { id: 'trucks', label: 'My Trucks' },
  { id: 'available', label: 'Available Jobs' },
  { id: 'jobs', label: 'My Jobs' },
];

const EMPTY_TRUCK_FORM = {
  registration: '',
  truckType: '',
  capacity: '',
  operatingArea: '',
};

const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'];

export default function TruckOwnerDashboard() {
  const [trucks, setTrucks] = useState([]);
  const [openJobs, setOpenJobs] = useState([]);
  const [myJobs, setMyJobs] = useState([]);

  const [activeTab, setActiveTab] = useState('trucks');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);

  const [toastMsg, setToastMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [truckForm, setTruckForm] = useState(EMPTY_TRUCK_FORM);

  function toast(message) {
    setToastMsg(message);

    window.setTimeout(() => {
      setToastMsg('');
    }, 3000);
  }

  function getErrorMessage(err, fallback) {
    return (
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      fallback
    );
  }

  async function loadAll(showLoading = false) {
    if (showLoading) setLoading(true);

    try {
      setErrorMsg('');

      const [trucksRes, openRes, mineRes] = await Promise.all([
        api.get('/transport/trucks/mine'),
        api.get('/transport/open'),
        api.get('/transport/mine'),
      ]);

      setTrucks(trucksRes.data?.trucks || []);
      setOpenJobs(openRes.data?.jobs || []);
      setMyJobs(mineRes.data?.jobs || []);
    } catch (err) {
      setErrorMsg(
        getErrorMessage(
          err,
          'Unable to load transport dashboard data.'
        )
      );
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    loadAll(true);
  }, []);

  const activeJobs = useMemo(
    () =>
      myJobs.filter(
        (job) => !TERMINAL_STATUSES.includes(job.status)
      ),
    [myJobs]
  );

  const completedJobs = useMemo(
    () => myJobs.filter((job) => job.status === 'DELIVERED'),
    [myJobs]
  );

  const availableTrucks = useMemo(
    () =>
      trucks.filter(
        (truck) => truck.availability === 'AVAILABLE'
      ),
    [trucks]
  );

  async function registerTruck(event) {
    event.preventDefault();

    if (!truckForm.capacity || Number(truckForm.capacity) <= 0) {
      toast('Enter a valid truck capacity.');
      return;
    }

    setActionLoading('register-truck');

    try {
      await api.post('/transport/trucks', {
        registration: truckForm.registration.trim(),
        truckType: truckForm.truckType.trim(),
        capacity: Number(truckForm.capacity),
        operatingArea: truckForm.operatingArea.trim(),
      });

      setTruckForm(EMPTY_TRUCK_FORM);

      toast('Truck registered successfully.');

      await loadAll(false);
    } catch (err) {
      toast(
        getErrorMessage(
          err,
          'Could not register the truck.'
        )
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function setAvailability(truckId, availability) {
    setActionLoading(`availability-${truckId}`);

    try {
      await api.patch(
        `/transport/trucks/${truckId}/availability`,
        { availability }
      );

      toast(`Truck marked ${availability.toLowerCase()}.`);

      await loadAll(false);
    } catch (err) {
      toast(
        getErrorMessage(
          err,
          'Could not update truck availability.'
        )
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function respondToJob(job) {
    const available = trucks.filter(t => t.availability === 'AVAILABLE' && (!job.requiredCapacity || t.capacity >= Number(job.requiredCapacity)));
    if (!available.length) { toast('No available truck meets this request.'); return; }
    const amount = window.prompt(`Transport quote in ETB for ${job.load}:`);
    if (amount === null) return;
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { toast('Enter a valid positive quote.'); return; }
    setActionLoading(`job-${job.id}-QUOTE`);
    try {
      await api.post(`/transport/${job.id}/quotes`, { truckId: available[0].id, amount: Number(amount) });
      toast('Transport quote submitted. The buyer/seller can now choose your quote.');
      await loadAll(false); setActiveTab('jobs');
    } catch (err) { toast(getErrorMessage(err,'Could not submit transport quote.')); }
    finally { setActionLoading(null); }
  }

  async function updateStatus(jobId, status) {
    setActionLoading(`status-${jobId}-${status}`);

    try {
      await api.patch(
        `/transport/${jobId}/status`,
        { status }
      );

      const messages = {
        PICKUP: 'Pickup confirmed.',
        IN_TRANSIT: 'Trip marked in transit.',
        DELIVERED: 'Delivery marked completed.',
        CANCELLED: 'Transport job cancelled.',
      };

      toast(messages[status] || 'Transport status updated.');

      await loadAll(false);
    } catch (err) {
      toast(
        getErrorMessage(
          err,
          'Could not update transport status.'
        )
      );
    } finally {
      setActionLoading(null);
    }
  }

  function getArrangingPartyLabel(arrangingParty) {
    switch (arrangingParty) {
      case 'SELLER':
        return 'Seller arranging';
      case 'BUYER':
        return 'Buyer arranging';
      case 'JOINT':
        return 'Buyer + Seller';
      default:
        return 'Marketplace request';
    }
  }

  function getStatusClass(status) {
    if (status === 'DELIVERED') return 'sd-badge';
    if (status === 'CANCELLED') return 'sd-badge sd-warn';
    if (status === 'IN_TRANSIT') return 'sd-badge sd-blue';

    return 'sd-badge sd-warn';
  }

  function renderJobActionButtons(job) {
    const busy = actionLoading?.startsWith(`status-${job.id}`);

    if (job.status === 'ACCEPTED' || job.status === 'QUOTED') {
      return (
        <button
          className="sd-btn sd-btn-outline"
          disabled={busy}
          onClick={() => updateStatus(job.id, 'PICKUP')}
        >
          {busy ? 'Updating...' : 'Mark picked up'}
        </button>
      );
    }

    if (job.status === 'PICKUP') {
      return (
        <button
          className="sd-btn sd-btn-outline"
          disabled={busy}
          onClick={() => updateStatus(job.id, 'IN_TRANSIT')}
        >
          {busy ? 'Updating...' : 'Mark in transit'}
        </button>
      );
    }

    if (job.status === 'IN_TRANSIT') {
      return (
        <button
          className="sd-btn sd-btn-primary"
          disabled={busy}
          onClick={() => updateStatus(job.id, 'DELIVERED')}
        >
          {busy ? 'Updating...' : 'Mark delivered'}
        </button>
      );
    }

    return null;
  }

  if (loading) {
    return (
      <div className="sd-dashboard">
        <section>
          <span className="sd-eyebrow">TRANSPORT DASHBOARD</span>
          <h1>Loading your transport workspace...</h1>
          <p className="sd-muted">
            Loading trucks, available requests and your transport jobs.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="sd-dashboard">

      {/* =========================================================
          HEADER / SUMMARY
      ========================================================= */}

      <section>
        <span className="sd-eyebrow">TRANSPORT DASHBOARD</span>

        <h1>Your trucks, your jobs, your routes.</h1>

        <p
          className="sd-muted"
          style={{ maxWidth: 780 }}
        >
          Register your trucks, receive agricultural transport
          requests created through MarketBridge, respond to jobs,
          and manage accepted trips through delivery.
        </p>

        <div className="sd-stat-grid">

          <div className="sd-stat">
            <span>REGISTERED TRUCKS</span>
            <b>{trucks.length}</b>
          </div>

          <div className="sd-stat">
            <span>AVAILABLE TRUCKS</span>
            <b>{availableTrucks.length}</b>
          </div>

          <div className="sd-stat">
            <span>AVAILABLE JOBS</span>
            <b>{openJobs.length}</b>
          </div>

          <div className="sd-stat">
            <span>ACTIVE JOBS</span>
            <b>{activeJobs.length}</b>
          </div>

          <div className="sd-stat">
            <span>COMPLETED TRIPS</span>
            <b>{completedJobs.length}</b>
          </div>

        </div>
      </section>

      {/* =========================================================
          ERROR
      ========================================================= */}

      {errorMsg && (
        <section>
          <div
            className="sd-panel"
            style={{
              border: '1px solid #c0392b',
              marginBottom: 20,
            }}
          >
            <strong>Unable to load dashboard</strong>

            <p className="sd-muted">
              {errorMsg}
            </p>

            <button
              className="sd-btn sd-btn-outline"
              onClick={() => loadAll(true)}
            >
              Try again
            </button>
          </div>
        </section>
      )}

      {/* =========================================================
          TABS
      ========================================================= */}

      <section>

        <div className="sd-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`sd-tab ${
                activeTab === tab.id ? 'sd-active' : ''
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}

              {tab.id === 'available' && openJobs.length > 0 && (
                <span style={{ marginLeft: 6 }}>
                  ({openJobs.length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* =======================================================
            MY TRUCKS
        ======================================================= */}

        {activeTab === 'trucks' && (
          <div>

            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">FLEET</span>
                <h2>Register a truck</h2>
              </div>
            </div>

            <div
              className="sd-panel"
              style={{ marginBottom: 20 }}
            >
              <form onSubmit={registerTruck}>

                <div className="sd-form-grid">

                  <div>
                    <label htmlFor="registration">
                      Registration plate
                    </label>

                    <input
                      id="registration"
                      required
                      value={truckForm.registration}
                      onChange={(e) =>
                        setTruckForm({
                          ...truckForm,
                          registration: e.target.value,
                        })
                      }
                      placeholder="e.g. ET-12345"
                    />
                  </div>

                  <div>
                    <label htmlFor="truckType">
                      Truck type
                    </label>

                    <input
                      id="truckType"
                      required
                      value={truckForm.truckType}
                      onChange={(e) =>
                        setTruckForm({
                          ...truckForm,
                          truckType: e.target.value,
                        })
                      }
                      placeholder="e.g. Flatbed, Isuzu, FSR"
                    />
                  </div>

                  <div>
                    <label htmlFor="capacity">
                      Capacity (tons)
                    </label>

                    <input
                      id="capacity"
                      required
                      min="0.1"
                      step="0.1"
                      type="number"
                      value={truckForm.capacity}
                      onChange={(e) =>
                        setTruckForm({
                          ...truckForm,
                          capacity: e.target.value,
                        })
                      }
                      placeholder="e.g. 18"
                    />
                  </div>

                  <div>
                    <label htmlFor="operatingArea">
                      Operating area / routes
                    </label>

                    <input
                      id="operatingArea"
                      value={truckForm.operatingArea}
                      onChange={(e) =>
                        setTruckForm({
                          ...truckForm,
                          operatingArea: e.target.value,
                        })
                      }
                      placeholder="e.g. Addis Ababa – Jimma"
                    />
                  </div>

                </div>

                <div
                  className="sd-modal-actions"
                  style={{ marginTop: 20 }}
                >
                  <button
                    type="submit"
                    className="sd-btn sd-btn-primary"
                    disabled={actionLoading === 'register-truck'}
                  >
                    {actionLoading === 'register-truck'
                      ? 'Registering...'
                      : 'Register truck'}
                  </button>
                </div>

              </form>
            </div>

            {/* ---------------------------------------------------
                REGISTERED TRUCKS
            --------------------------------------------------- */}

            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">FLEET</span>
                <h2>My trucks</h2>
              </div>
            </div>

            <div className="sd-cards">

              {trucks.map((truck) => {

                const availabilityBusy =
                  actionLoading ===
                  `availability-${truck.id}`;

                return (
                  <div
                    className="sd-card"
                    key={truck.id}
                  >
                    <h3>{truck.truckType}</h3>

                    <p className="sd-muted">
                      {truck.registration}
                      {' · '}
                      {truck.capacity}t
                      {' · '}
                      {truck.operatingArea || 'No area set'}
                    </p>

                    <p>
                      <strong>Availability:</strong>{' '}

                      <span
                        className={
                          truck.availability === 'AVAILABLE'
                            ? 'sd-badge'
                            : 'sd-badge sd-warn'
                        }
                      >
                        {truck.availability}
                      </span>
                    </p>

                    {truck.verificationStatus && (
                      <p className="sd-muted">
                        Verification:{' '}
                        {truck.verificationStatus}
                      </p>
                    )}

                    <div
                      style={{
                        marginTop: 10,
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        disabled={availabilityBusy}
                        onClick={() =>
                          setAvailability(
                            truck.id,
                            'AVAILABLE'
                          )
                        }
                      >
                        Available
                      </button>

                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        disabled={availabilityBusy}
                        onClick={() =>
                          setAvailability(
                            truck.id,
                            'BUSY'
                          )
                        }
                      >
                        Busy
                      </button>

                      <button
                        type="button"
                        className="sd-btn sd-btn-outline"
                        disabled={availabilityBusy}
                        onClick={() =>
                          setAvailability(
                            truck.id,
                            'OFFLINE'
                          )
                        }
                      >
                        Offline
                      </button>
                    </div>
                  </div>
                );
              })}

              {trucks.length === 0 && (
                <div className="sd-panel">
                  <p>
                    No trucks registered yet.
                  </p>

                  <p className="sd-muted">
                    Register a truck above to start
                    receiving suitable MarketBridge
                    transport requests.
                  </p>
                </div>
              )}

            </div>
          </div>
        )}

        {/* =======================================================
            AVAILABLE JOBS
        ======================================================= */}

        {activeTab === 'available' && (
          <div>

            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">
                  MARKETPLACE
                </span>

                <h2>
                  Open transport requests
                </h2>

                <p className="sd-muted">
                  These are buyer-, seller-, or
                  jointly-arranged transport requests
                  that require a transporter.
                </p>
              </div>
            </div>

            <div className="sd-cards">

              {openJobs.map((job) => {

                const quoting =
                  actionLoading ===
                  `job-${job.id}-QUOTE`;

                return (
                  <div
                    className="sd-card"
                    key={job.id}
                  >
                    <h3>{job.load}</h3>

                    <p className="sd-muted">
                      <strong>Pickup:</strong>{' '}
                      {job.pickupLocation}
                    </p>

                    <p className="sd-muted">
                      <strong>Destination:</strong>{' '}
                      {job.destination}
                    </p>

                    {job.requiredCapacity && (
                      <p className="sd-muted">
                        <strong>Required capacity:</strong>{' '}
                        {job.requiredCapacity}t+
                      </p>
                    )}

                    {job.specialRequirements && (
                      <p className="sd-muted">
                        <strong>Requirements:</strong>{' '}
                        {job.specialRequirements}
                      </p>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                        marginTop: 10,
                      }}
                    >
                      <span className="sd-badge sd-warn">
                        {getArrangingPartyLabel(
                          job.arrangingParty
                        )}
                      </span>

                      <span className="sd-badge sd-blue">
                        {job.method}
                      </span>
                    </div>

                    <div
                      style={{
                        marginTop: 14,
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <button type="button" className="sd-btn sd-btn-primary" disabled={quoting} onClick={() => respondToJob(job)}>{quoting ? 'Sending...' : 'Submit transport quote'}</button>
                    </div>

                  </div>
                );
              })}

              {openJobs.length === 0 && (
                <div className="sd-panel">
                  <h3>
                    No open transport requests
                  </h3>

                  <p className="sd-muted">
                    New requests will appear here when
                    buyers or sellers choose
                    <strong> Hire Transporter</strong>
                    through MarketBridge.
                  </p>
                </div>
              )}

            </div>
          </div>
        )}

        {/* =======================================================
            MY JOBS
        ======================================================= */}

        {activeTab === 'jobs' && (
          <div>

            <div className="sd-toolbar">
              <div>
                <span className="sd-eyebrow">
                  MY JOBS
                </span>

                <h2>
                  Active and completed trips
                </h2>

                <p className="sd-muted">
                  Manage accepted transport jobs from
                  pickup through delivery.
                </p>
              </div>
            </div>

            <div className="sd-panel sd-table-wrap">

              <table className="sd-table">

                <thead>
                  <tr>
                    <th>Load</th>
                    <th>Route</th>
                    <th>Arranged by</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>

                <tbody>

                  {myJobs.map((job) => (
                    <tr key={job.id}>

                      <td>
                        <strong>
                          {job.load}
                        </strong>

                        {job.requiredCapacity && (
                          <div className="sd-muted">
                            {job.requiredCapacity}t+
                          </div>
                        )}
                      </td>

                      <td>
                        <div>
                          {job.pickupLocation}
                        </div>

                        <div className="sd-muted">
                          ↓
                        </div>

                        <div>
                          {job.destination}
                        </div>
                      </td>

                      <td>
                        {getArrangingPartyLabel(
                          job.arrangingParty
                        )}
                      </td>

                      <td>
                        <span
                          className={getStatusClass(
                            job.status
                          )}
                        >
                          {job.status}
                        </span>
                      </td>

                      <td>
                        <div
                          style={{
                            display: 'flex',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          {renderJobActionButtons(job)}

                          {job.status === 'DELIVERED' && (
                            <span className="sd-muted">
                              Trip completed
                            </span>
                          )}

                          {job.status === 'CANCELLED' && (
                            <span className="sd-muted">
                              Cancelled
                            </span>
                          )}
                        </div>
                      </td>

                    </tr>
                  ))}

                  {myJobs.length === 0 && (
                    <tr>
                      <td colSpan="5">
                        No transport jobs yet.
                      </td>
                    </tr>
                  )}

                </tbody>

              </table>

            </div>
          </div>
        )}

      </section>

      {/* =========================================================
          TOAST
      ========================================================= */}

      {toastMsg && (
        <div
          className="sd-toast"
          role="status"
          aria-live="polite"
        >
          {toastMsg}
        </div>
      )}

    </div>
  );
}
