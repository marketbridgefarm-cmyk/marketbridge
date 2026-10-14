import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { EMPTY_TRUCK_FORM, TERMINAL_STATUSES } from '../components/truckOwner/truckOwnerHelpers.js';

// State, data loading (10s polling) and action handlers for the transport-owner
// dashboard. Extracted verbatim from pages/TruckOwnerDashboard.jsx; the page and
// components under components/truckOwner/ only render.
export default function useTruckOwnerDashboard() {
  const [trucks, setTrucks] = useState([]);
  const [openJobs, setOpenJobs] = useState([]);
  const [myJobs, setMyJobs] = useState([]);

  const [activeTab, setActiveTab] = useState('trucks');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [releaseTarget, setReleaseTarget] = useState(null);

  const [toastMsg, setToastMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [truckForm, setTruckForm] = useState(EMPTY_TRUCK_FORM);
  const [showTruckModal, setShowTruckModal] = useState(false);
  // Select-only price entry for quotes / counters (no free typing, so no
  // phone numbers can be slipped into a price box).
  const [amountModal, setAmountModal] = useState(null); // { kind, job?, jobId?, quoteId?, reference }
  const [amountDraft, setAmountDraft] = useState('');

  // Evidence capture, required by the backend before PICKUP -> IN_TRANSIT
  // (needs PICKUP evidence) and IN_TRANSIT -> DELIVERED (needs DELIVERY evidence).
  // Payment completeness (seller, transport, inspection) is enforced by the
  // backend before ACCEPTED -> PICKUP, i.e. before the truck collects the goods.
  const [evidenceModal, setEvidenceModal] = useState(null); // { jobId, type, nextStatus }
  const [evidenceKeys, setEvidenceKeys] = useState({ photoKeys: [], videoKeys: [] });
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [evidenceGps, setEvidenceGps] = useState('');
  const [evidenceError, setEvidenceError] = useState('');
  const [submittingEvidence, setSubmittingEvidence] = useState(false);

  // FIXED: The loading-prep report and the pickup-handoff coordination are
  // now submitted from the transporter's own workspace instead of from the
  // buyer's OrderDetail page. These two states drive the in-dashboard modals.
  const [loadingReportJobId, setLoadingReportJobId] = useState(null);
  const [coordModalJobId, setCoordModalJobId] = useState(null);

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
    let mounted = true;
    let timer;

    const refresh = async () => {
      if (!mounted) return;
      await loadAll(false);
      if (mounted) timer = window.setTimeout(refresh, 10000);
    };

    loadAll(true).then(() => {
      if (mounted) timer = window.setTimeout(refresh, 10000);
    });

    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
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

  const activityItems = myJobs.map((job) => ({
    id: `job-${job.id}`,
    icon: '🚛',
    text: `Job to ${job.destination || 'destination'} is ${job.status.toLowerCase().replaceAll('_', ' ')}`,
    time: job.updatedAt || job.createdAt,
    href: `/orders/${job.orderId}`,
  }));

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
      setShowTruckModal(false);
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
    const available = trucks.filter(
      (t) =>
        t.availability === 'AVAILABLE' &&
        (!job.requiredCapacity || t.capacity >= Number(job.requiredCapacity))
    );

    if (!available.length) {
      toast('No available truck meets this request.');
      return;
    }

    setAmountDraft('');
    setAmountModal({ kind: 'quote', job, reference: null });
    return;
  }

  async function submitJobQuote(job, amount) {
    const available = trucks.filter(
      (t) =>
        t.availability === 'AVAILABLE' &&
        (!job.requiredCapacity || t.capacity >= Number(job.requiredCapacity))
    );
    if (!available.length) {
      toast('No available truck meets this request.');
      return;
    }

    setActionLoading(`job-${job.id}-QUOTE`);

    try {
      await api.post(`/transport/${job.id}/quotes`, {
        truckId: available[0].id,
        amount: Number(amount),
      });
      toast('Transport quote submitted. The buyer can compare your sealed bid with other transporters.');
      await loadAll(false);
      setActiveTab('jobs');
    } catch (err) {
      toast(getErrorMessage(err, 'Could not submit transport quote.'));
    } finally {
      setActionLoading(null);
    }
  }

  // Transport quote URLs now match the inspection shape:
  //   /transport/:jobId/quotes/:quoteId/<action>
  // Every caller already has the job in scope; jobId is threaded explicitly.

  // Release a provisionally accepted deal (before transport payment) or a
  // silent negotiator (SELECTED / COUNTERED-by-requester) once the backend's
  // release window has elapsed. This is a WITHDRAW, not a REJECT: the backend
  // only allows REJECT on quotes that are still being negotiated.
  function releaseTransportAgreement(jobId, quoteId) {
    setReleaseTarget({ jobId, quoteId });
  }

  async function confirmReleaseTransportAgreement({ reason, note }) {
    if (!releaseTarget) return;
    const { jobId, quoteId } = releaseTarget;
    setActionLoading(`quote-${quoteId}`);
    try {
      await api.patch(`/transport/${jobId}/quotes/${quoteId}/withdraw`, {
        reason,
        note: note || undefined,
      });
      setReleaseTarget(null);
      toast('Agreement cancelled. The requester can now choose another transporter.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not release this agreement.'));
    } finally {
      setActionLoading(null);
    }
  }

  async function acceptTransportQuote(jobId, quoteId) {
    setActionLoading(`quote-${quoteId}`);
    try {
      await api.patch(`/transport/${jobId}/quotes/${quoteId}/accept`);
      toast('Requester\u2019s price accepted. The transport deal is provisional until payment settles.');
      await loadAll(false);
      setActiveTab('jobs');
    } catch (err) {
      toast(getErrorMessage(err, 'Could not accept this negotiation.'));
    } finally {
      setActionLoading(null);
    }
  }

  function counterTransportQuote(jobId, quoteId, reference) {
    setAmountDraft('');
    setAmountModal({ kind: 'counter', jobId, quoteId, reference: Number(reference) || null });
  }

  async function submitTransportCounter(jobId, quoteId, amount) {
    setActionLoading(`quote-${quoteId}`);

    try {
      await api.post(`/transport/${jobId}/quotes/${quoteId}/counter`, {
        counterAmount: Number(amount),
      });
      toast('Counter-offer sent to the requester.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not send counter-offer.'));
    } finally {
      setActionLoading(null);
    }
  }

  async function rejectTransportQuote(jobId, quoteId) {
    setActionLoading(`quote-${quoteId}`);
    try {
      await api.patch(`/transport/${jobId}/quotes/${quoteId}/reject`);
      toast('Negotiation ended.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not reject this negotiation.'));
    } finally {
      setActionLoading(null);
    }
  }

  // Withdraw a waiting bid that the requester has not yet selected for
  // negotiation. Mirrors the inspection flow: only a PENDING bid can be
  // withdrawn, so a live negotiation is never abandoned by accident.
  async function withdrawWaitingBid(jobId, quoteId) {
    setActionLoading(`quote-${quoteId}`);
    try {
      await api.post(`/transport/${jobId}/quotes/${quoteId}/withdraw-bid`);
      toast('Your bid has been withdrawn. You can submit a new one on any other request.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not withdraw this bid.'));
    } finally {
      setActionLoading(null);
    }
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

  // FIXED: separate handler so the "truck arrived on site" action doesn't
  // have to go through the /status route (which has a different payload and
  // validation). Backend endpoint: POST /transport/:id/truck-arrived.
  async function confirmTruckArrived(jobId) {
    setActionLoading(`status-${jobId}-ARRIVED`);
    try {
      await api.post(`/transport/${jobId}/truck-arrived`);
      toast('Truck arrival confirmed.');
      await loadAll(false);
    } catch (err) {
      toast(getErrorMessage(err, 'Could not confirm truck arrival.'));
    } finally {
      setActionLoading(null);
    }
  }

  function openEvidenceModal(jobId, type, nextStatus) {
    setEvidenceModal({ jobId, type, nextStatus });
    setEvidenceKeys({ photoKeys: [], videoKeys: [] });
    setEvidenceNotes('');
    setEvidenceGps('');
    setEvidenceError('');
  }

  function closeEvidenceModal() {
    setEvidenceModal(null);
  }

  async function submitEvidenceAndAdvance() {
    if (!evidenceModal) return;
    const { jobId, type, nextStatus } = evidenceModal;

    if (
      !evidenceKeys.photoKeys.length &&
      !evidenceKeys.videoKeys.length &&
      !evidenceNotes &&
      !evidenceGps
    ) {
      setEvidenceError('Upload a photo/video or add notes/GPS before continuing.');
      return;
    }

    setSubmittingEvidence(true);
    setEvidenceError('');

    try {
      await api.post(`/transport/${jobId}/evidence`, {
        type,
        photos: evidenceKeys.photoKeys,
        videos: evidenceKeys.videoKeys,
        notes: evidenceNotes || undefined,
        gpsLocation: evidenceGps || undefined,
      });

      closeEvidenceModal();
      await updateStatus(jobId, nextStatus);
    } catch (err) {
      setEvidenceError(
        getErrorMessage(err, `Could not record ${type.toLowerCase()} evidence.`)
      );
    } finally {
      setSubmittingEvidence(false);
    }
  }

  return {
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
  };
}
