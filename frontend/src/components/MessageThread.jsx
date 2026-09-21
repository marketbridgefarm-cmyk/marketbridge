import React, { useState } from 'react';
import api from '../api/client';
import Collapsible from './Collapsible.jsx';

export default function MessageThread({ orderId, messages, counterpartId, counterpartName, currentUserId, onSent }) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    const text = content.trim();
    if (!text) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/messages', { receiverId: counterpartId, content: text, orderId });
      setContent('');
      onSent?.(r.data.message);
    } catch (e) {
      setError(e.response?.data?.error || e.response?.data?.errors?.[0]?.msg || 'Could not send message');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!counterpartId) return null;

  const count = messages?.length || 0;

  return (
    <Collapsible
      title={`Messages with ${counterpartName || 'the other party'}`}
      summary={count > 0 && <span className="muted" style={{ fontSize: 13 }}>{count} message{count === 1 ? '' : 's'}</span>}
    >
      <div className="message-thread">
        {(!messages || messages.length === 0) && <p className="muted">No messages yet — say hello.</p>}
        {(messages || []).map((m) => (
          <div key={m.id} className={`message-bubble ${m.senderId === currentUserId ? 'message-mine' : 'message-theirs'}`}>
            <p>{m.content}</p>
            <span className="message-time">{new Date(m.createdAt).toLocaleString()}</span>
          </div>
        ))}
      </div>
      {error && <div className="alert error small">{error}</div>}
      <div className="message-composer">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Write a message about this order…"
          maxLength={5000}
        />
        <button className="btn btn-primary btn-sm" disabled={busy || !content.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </Collapsible>
  );
}
