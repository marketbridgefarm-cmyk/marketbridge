import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { prepareAvatar } from '../utils/prepareAvatar.js';
import './AvatarPicker.css';

// Profile-photo chooser used at sign-up and on the Account page.
//   name      – shown as initials until a photo exists
//   src       – the photo already saved on the account (Account page)
//   onSelect  – called with the prepared (square, small) File after the person picks a photo
//   onRemove  – called when they remove the photo
//   busy      – parent is uploading/removing; disables the buttons
export default function AvatarPicker({ name, src, onSelect, onRemove, busy = false, error = '', hint }) {
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const shown = preview || src || null;
  const disabled = busy || working;

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';                      // allow choosing the same file again later
    if (!file) return;
    setLocalError('');
    setWorking(true);
    try {
      const prepared = await prepareAvatar(file);
      setPreview(URL.createObjectURL(prepared));
      await onSelect?.(prepared);
    } catch (err) {
      setLocalError(err.message || 'Could not use that photo.');
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    setLocalError('');
    setPreview(null);
    try { await onRemove?.(); } catch (err) { setLocalError(err.message || 'Could not remove the photo.'); }
  }

  const message = localError || error;

  return (
    <div className="avp">
      <label className={`avp-frame${disabled ? ' is-busy' : ''}`}>
        {!shown && !name?.trim() ? (
          <span className="avp-ph" aria-hidden="true">
            <svg width="54" height="54" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8.2" r="4.1" /><path d="M3.8 21c.6-4.4 3.9-6.9 8.2-6.9s7.6 2.5 8.2 6.9H3.8z" /></svg>
          </span>
        ) : (
          <Avatar name={name} src={shown} size="xl" />
        )}
        <span className="avp-cam" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="3.4" /></svg>
        </span>
        <input ref={inputRef} className="avp-input" type="file" accept="image/*" onChange={onFile} disabled={disabled} aria-label={shown ? 'Change profile photo' : 'Add profile photo'} />
      </label>

      <div className="avp-actions">
        <button type="button" className="avp-btn" onClick={() => inputRef.current?.click()} disabled={disabled}>
          {working ? 'Preparing…' : shown ? 'Change photo' : 'Add photo'}
        </button>
        {shown && (
          <button type="button" className="avp-btn avp-btn--ghost" onClick={remove} disabled={disabled}>Remove</button>
        )}
      </div>

      {message
        ? <p className="avp-msg avp-msg--error" role="alert">{message}</p>
        : <p className="avp-msg">{hint || 'Optional. A clear photo of your face helps buyers and sellers trust you.'}</p>}
    </div>
  );
}
