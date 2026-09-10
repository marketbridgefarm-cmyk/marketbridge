import React, { useEffect, useState } from 'react';
import api from '../api/client';

// Lists evidence entries fetched from `listUrl` ({ evidence: [...] }) and,
// on demand, signs each entry's media via `mediaUrl(evidenceId)` so photos
// and videos can be viewed without exposing raw storage keys.
export default function EvidenceGallery({ listUrl, mediaUrl }) {
  const [evidence, setEvidence] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signed, setSigned] = useState({});
  const [signing, setSigning] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(listUrl)
      .then((res) => {
        if (!cancelled) setEvidence(res.data?.evidence || []);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load evidence.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [listUrl]);

  async function viewMedia(item) {
    setSigning(item.id);
    try {
      const res = await api.get(mediaUrl(item.id));
      setSigned((prev) => ({ ...prev, [item.id]: res.data?.media }));
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load media.');
    } finally {
      setSigning('');
    }
  }

  if (loading) return <p className="muted small">Loading evidence…</p>;
  if (error) return <div className="alert error">{error}</div>;
  if (!evidence.length) return <p className="muted small">No evidence recorded yet.</p>;

  return (
    <div className="evidence-gallery">
      {evidence.map((item) => (
        <div key={item.id} className="evidence-item card">
          <div className="row-between">
            <strong>{item.type}</strong>
            <span className="muted small">{new Date(item.capturedAt).toLocaleString()}</span>
          </div>
          {item.notes && <p className="small">{item.notes}</p>}
          {item.gpsLocation && <p className="muted small">GPS: {item.gpsLocation}</p>}

          {!signed[item.id] ? (
            <button
              type="button"
              className="btn btn-light btn-sm"
              disabled={signing === item.id}
              onClick={() => viewMedia(item)}
            >
              {signing === item.id ? 'Loading…' : `View media (${(item.photos?.length || 0) + (item.videos?.length || 0)})`}
            </button>
          ) : (
            <div className="evidence-media-grid">
              {signed[item.id].photos?.map((p) => (
                <a key={p.url} href={p.url} target="_blank" rel="noreferrer">
                  <img src={p.url} alt="Evidence" className="evidence-thumb" />
                </a>
              ))}
              {signed[item.id].videos?.map((v) => (
                <a key={v.url} href={v.url} target="_blank" rel="noreferrer" className="btn btn-light btn-sm">
                  View video
                </a>
              ))}
              {!signed[item.id].photos?.length && !signed[item.id].videos?.length && (
                <p className="muted small">Media is unavailable.</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
