import React, { useState } from 'react';
import api from '../api/client';
import './MessageThread.css';

export default function MessageThread({
  orderId,
  messages,
  counterpartId,
  counterpartName,
  currentUserId,
  onSent,
}) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Sayings starts open so the latest message is always visible on
  // first render; the user can collapse it to hide the history.
  const [sayingsOpen, setSayingsOpen] = useState(true);

  async function send() {
    const text = content.trim();
    if (!text) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/messages', {
        receiverId: counterpartId,
        content: text,
        orderId,
      });
      setContent('');
      onSent?.(r.data.message);
    } catch (e) {
      setError(
        e.response?.data?.error ||
          e.response?.data?.errors?.[0]?.msg ||
          'Could not send message'
      );
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

  const partyName = counterpartName || 'the other party';
  const count = messages?.length || 0;

  return (
    <section className="card message-thread-card">
      {/* Card header — eyebrow + title */}
      <header className="card-head">
        <div className="card-head-text">
          <span className="eyebrow">MESSAGES</span>
          <h2>Messages with {partyName}</h2>
        </div>
        <span className="card-block-note">
          {count} message{count === 1 ? '' : 's'}
        </span>
      </header>

      <div className="card-body">
        {/* Content block — Conversation with <name> */}
        <section className="card-block">
          <div className="card-block-title">
            <h3>Conversation with {partyName}</h3>
          </div>

          <div className="card-block-body">
            {/* Sayings — collapsible message history */}
            <details
              className="message-sayings"
              open={sayingsOpen}
              onToggle={(e) => setSayingsOpen(e.currentTarget.open)}
            >
              <summary className="message-sayings-summary">
                <span className="message-sayings-label">Sayings</span>
                <span className="message-sayings-count">{count}</span>
                <span className="message-sayings-chevron" aria-hidden="true">
                  ▾
                </span>
              </summary>

              <div className="message-thread">
                {(!messages || messages.length === 0) && (
                  <p className="muted">No messages yet — say hello.</p>
                )}

                {(messages || []).map((m) => (
                  <div
                    key={m.id}
                    className={`message-bubble ${
                      m.senderId === currentUserId
                        ? 'message-mine'
                        : 'message-theirs'
                    }`}
                  >
                    <p>{m.content}</p>
                    <span className="message-time">
                      {new Date(m.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </section>

        {error && <div className="alert error small">{error}</div>}

        {/* Composer — action footer at the bottom of the card */}
        <div className="message-composer">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Write a message about this order…"
            maxLength={5000}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !content.trim()}
            onClick={send}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  );
}
