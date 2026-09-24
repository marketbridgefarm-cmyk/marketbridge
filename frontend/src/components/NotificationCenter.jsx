import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export default function NotificationCenter() {
  const navigate = useNavigate();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  async function loadNotifications(showSpinner = false) {
    if (showSpinner) setLoading(true);
    try {
      const response = await api.get('/notifications?limit=20');
      setNotifications(response.data?.notifications || []);
      setUnreadCount(Number(response.data?.unreadCount || 0));
    } catch (error) {
      // Notification polling should never interrupt the main marketplace UI.
      console.error('Failed to load notifications:', error);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }

  useEffect(() => {
    loadNotifications();
    const interval = window.setInterval(() => loadNotifications(), 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;

    function onDocClick(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function openNotification(notification) {
    try {
      if (!notification.readAt) {
        await api.patch(`/notifications/${notification.id}/read`);
        setNotifications((items) => items.map((item) => (
          item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item
        )));
        setUnreadCount((count) => Math.max(0, count - 1));
      }
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }

    const path = notification.action?.path;
    setOpen(false);
    if (path) navigate(path);
  }

  async function markAllRead() {
    if (unreadCount === 0) return;
    try {
      await api.post('/notifications/read-all');
      const now = new Date().toISOString();
      setNotifications((items) => items.map((item) => ({ ...item, readAt: item.readAt || now })));
      setUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark notifications as read:', error);
    }
  }

  return (
    <div className="notification-center" ref={rootRef}>
      <button
        type="button"
        className="notification-trigger"
        aria-label={unreadCount ? `${unreadCount} unread notifications` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) loadNotifications(true);
        }}
      >
        <span className="notification-bell" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </svg>
        </span>
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <div className="notification-panel-header">
            <div>
              <strong>Notifications</strong>
              <span>{unreadCount} unread</span>
            </div>
            <button type="button" onClick={markAllRead} disabled={!unreadCount}>Mark all read</button>
          </div>

          {loading ? (
            <div className="notification-empty">Loading…</div>
          ) : notifications.length === 0 ? (
            <div className="notification-empty">You are all caught up.</div>
          ) : (
            <div className="notification-list">
              {notifications.map((notification) => (
                <button
                  type="button"
                  key={notification.id}
                  className={`notification-item${notification.readAt ? '' : ' unread'}`}
                  onClick={() => openNotification(notification)}
                >
                  <span className="notification-item-dot" aria-hidden="true" />
                  <span className="notification-item-content">
                    <strong>{notification.title}</strong>
                    <span>{notification.body}</span>
                    <small>{formatTime(notification.createdAt)}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
