import React from 'react';
import { TABS } from '../components/truckOwner/truckOwnerHelpers.js';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import RecentActivity from '../components/RecentActivity.jsx';
import ProviderReleaseDialog from '../components/ProviderReleaseDialog.jsx';
import ProviderStandingBanner from '../components/ProviderStandingBanner.jsx';
import MyTrucksTab from '../components/truckOwner/MyTrucksTab.jsx';
import AvailableJobsTab from '../components/truckOwner/AvailableJobsTab.jsx';
import MyJobsTab from '../components/truckOwner/MyJobsTab.jsx';
import TruckRegistrationModal from '../components/truckOwner/TruckRegistrationModal.jsx';
import PriceModal from '../components/truckOwner/PriceModal.jsx';
import EvidenceModal from '../components/truckOwner/EvidenceModal.jsx';
import LoadingReportModal from '../components/truckOwner/LoadingReportModal.jsx';
import PickupHandoffModal from '../components/truckOwner/PickupHandoffModal.jsx';
import useTruckOwnerDashboard from '../hooks/useTruckOwnerDashboard.js';
import { useAuth } from '../context/AuthContext.jsx';
import './dashboards/TruckOwnerDashboard.css';

// Transport-owner workspace. State and handlers live in hooks/useTruckOwnerDashboard.js;
// tabs and modals live in components/truckOwner/.
export default function TruckOwnerDashboard() {
  const { user } = useAuth();
  const {
    trucks,
    openJobs,
    myJobs,
    activeTab,
    setActiveTab,
    loading,
    actionLoading,
    releaseTarget,
    setReleaseTarget,
    toastMsg,
    errorMsg,
    truckForm,
    setTruckForm,
    showTruckModal,
    setShowTruckModal,
    amountModal,
    setAmountModal,
    amountDraft,
    setAmountDraft,
    evidenceModal,
    evidenceKeys,
    setEvidenceKeys,
    evidenceNotes,
    setEvidenceNotes,
    evidenceGps,
    setEvidenceGps,
    evidenceError,
    submittingEvidence,
    loadingReportJobId,
    setLoadingReportJobId,
    coordModalJobId,
    setCoordModalJobId,
    activeJobs,
    completedJobs,
    activityItems,
    availableTrucks,
    loadAll,
    registerTruck,
    setAvailability,
    respondToJob,
    submitJobQuote,
    releaseTransportAgreement,
    confirmReleaseTransportAgreement,
    acceptTransportQuote,
    counterTransportQuote,
    submitTransportCounter,
    rejectTransportQuote,
    withdrawWaitingBid,
    updateStatus,
    confirmTruckArrived,
    openEvidenceModal,
    closeEvidenceModal,
    submitEvidenceAndAdvance,
  } = useTruckOwnerDashboard();

  if (loading) {
    return (
      <div className="sd-dashboard">
        <section>
          <span className="sd-eyebrow">TRANSPORT DASHBOARD</span>
          <h1>Loading your transport workspace…</h1>
          <p className="sd-muted">
            Loading trucks, available requests and your transport jobs.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="sd-dashboard">
      <ProviderStandingBanner />

      {/* =========================================================
          HEADER / SUMMARY
      ========================================================= */}

      <section>
        <DashboardWelcome
          user={user}
          subtitle="Register your trucks, pick up transport jobs, and manage trips through delivery."
        />
        <span className="sd-eyebrow">TRANSPORT DASHBOARD</span>

        <h1>Your trucks, your jobs, your routes.</h1>

        <p className="sd-muted" style={{ maxWidth: 780 }}>
          Register your trucks, receive agricultural transport
          requests created through MarketBridge, respond to jobs,
          and manage accepted trips through delivery.
        </p>

        <RoleSwitchCTA current="TRUCK_OWNER" />
        <RecentActivity
          items={activityItems}
          emptyText="No transport jobs yet — check available jobs below."
        />

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
          <div className="sd-panel sd-panel--error">
            <strong>Unable to load dashboard</strong>
            <p className="sd-muted">{errorMsg}</p>
            <button
              type="button"
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
              className={`sd-tab ${activeTab === tab.id ? 'sd-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'available' && openJobs.length > 0 && (
                <span>({openJobs.length})</span>
              )}
            </button>
          ))}
        </div>

        {activeTab === 'trucks' && (
          <MyTrucksTab
            trucks={trucks}
            actionLoading={actionLoading}
            setShowTruckModal={setShowTruckModal}
            setAvailability={setAvailability}
          />
        )}

        {activeTab === 'available' && (
          <AvailableJobsTab
            openJobs={openJobs}
            actionLoading={actionLoading}
            respondToJob={respondToJob}
            withdrawWaitingBid={withdrawWaitingBid}
            acceptTransportQuote={acceptTransportQuote}
            counterTransportQuote={counterTransportQuote}
            rejectTransportQuote={rejectTransportQuote}
          />
        )}

        {activeTab === 'jobs' && (
          <MyJobsTab
            myJobs={myJobs}
            activeJobs={activeJobs}
            completedJobs={completedJobs}
            actionLoading={actionLoading}
            setActiveTab={setActiveTab}
            releaseTransportAgreement={releaseTransportAgreement}
            confirmTruckArrived={confirmTruckArrived}
            updateStatus={updateStatus}
            openEvidenceModal={openEvidenceModal}
            setLoadingReportJobId={setLoadingReportJobId}
            setCoordModalJobId={setCoordModalJobId}
          />
        )}

      </section>

      {/* =========================================================
          TOAST
      ========================================================= */}

      {toastMsg && (
        <div className="sd-toast" role="status" aria-live="polite">
          {toastMsg}
        </div>
      )}

      {showTruckModal && (
        <TruckRegistrationModal
          truckForm={truckForm}
          setTruckForm={setTruckForm}
          actionLoading={actionLoading}
          setShowTruckModal={setShowTruckModal}
          registerTruck={registerTruck}
        />
      )}

      {amountModal && (
        <PriceModal
          amountModal={amountModal}
          setAmountModal={setAmountModal}
          amountDraft={amountDraft}
          setAmountDraft={setAmountDraft}
          submitJobQuote={submitJobQuote}
          submitTransportCounter={submitTransportCounter}
        />
      )}

      {evidenceModal && (
        <EvidenceModal
          evidenceModal={evidenceModal}
          evidenceError={evidenceError}
          evidenceKeys={evidenceKeys}
          setEvidenceKeys={setEvidenceKeys}
          evidenceGps={evidenceGps}
          setEvidenceGps={setEvidenceGps}
          evidenceNotes={evidenceNotes}
          setEvidenceNotes={setEvidenceNotes}
          submittingEvidence={submittingEvidence}
          closeEvidenceModal={closeEvidenceModal}
          submitEvidenceAndAdvance={submitEvidenceAndAdvance}
        />
      )}

      {loadingReportJobId && (
        <LoadingReportModal
          loadingReportJobId={loadingReportJobId}
          myJobs={myJobs}
          setLoadingReportJobId={setLoadingReportJobId}
          loadAll={loadAll}
        />
      )}

      {coordModalJobId && (
        <PickupHandoffModal
          coordModalJobId={coordModalJobId}
          setCoordModalJobId={setCoordModalJobId}
        />
      )}

      <ProviderReleaseDialog
        open={Boolean(releaseTarget)}
        serviceLabel="transport agreement"
        busy={Boolean(releaseTarget) && actionLoading === `quote-${releaseTarget.quoteId}`}
        onConfirm={confirmReleaseTransportAgreement}
        onClose={() => setReleaseTarget(null)}
      />
    </div>
  );
}
