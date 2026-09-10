import React, { useState } from 'react';
import api from '../api/client';

// Uploads the selected files to `uploadUrl` (multipart) and returns the
// private storage keys via onUploaded({ photoKeys, videoKeys }).
// Kept deliberately small/self-contained so it can be dropped into any
// evidence-capture flow (transport pickup/delivery, inspection reports).
export default function EvidenceUploader({ uploadUrl, onUploaded, disabled }) {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function handleUpload() {
    if (!files.length) {
      setError('Choose at least one photo or video.');
      return;
    }

    setUploading(true);
    setError('');

    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('files', file));

      const res = await api.post(uploadUrl, formData);
      onUploaded?.({
        photoKeys: res.data?.photoKeys || [],
        videoKeys: res.data?.videoKeys || [],
      });
      setFiles([]);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not upload files.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="evidence-uploader">
      <input
        type="file"
        accept="image/*,video/mp4,video/quicktime"
        multiple
        disabled={disabled || uploading}
        onChange={(e) => setFiles(Array.from(e.target.files || []))}
      />
      {files.length > 0 && (
        <p className="muted small">{files.length} file(s) selected</p>
      )}
      {error && <div className="alert error">{error}</div>}
      <button
        type="button"
        className="btn btn-light btn-sm"
        disabled={disabled || uploading || !files.length}
        onClick={handleUpload}
      >
        {uploading ? 'Uploading…' : 'Upload'}
      </button>
    </div>
  );
}
