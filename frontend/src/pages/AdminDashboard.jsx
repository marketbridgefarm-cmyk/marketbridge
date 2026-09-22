import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import RoleSwitchCTA from '../components/RoleSwitchCTA.jsx';
import DashboardWelcome from '../components/DashboardWelcome.jsx';
import ImageCarousel from '../components/ImageCarousel.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const VERIFICATION_OPTIONS = ['PENDING', 'VERIFIED', 'REJECTED'];

const ROLE_OPTIONS = [
  'BUYER',
  'SELLER',
  'INSPECTOR',
  'TRUCK_OWNER',
  'ADVERTISER',
  'ADMIN',
];

const ACCOUNT_STATUS_OPTIONS = ['ACTIVE', 'SUSPENDED'];

const ADMIN_STYLES = `
  .admin-redesign {
    --admin-bg: #f5f7fb;
    --admin-surface: rgba(255,255,255,.94);
    --admin-surface-strong: #ffffff;
    --admin-border: rgba(15,23,42,.09);
    --admin-text: #172033;
    --admin-muted: #687386;
    --admin-primary: #176b4d;
    --admin-primary-dark: #0e513a;
    --admin-primary-soft: rgba(23,107,77,.10);
    --admin-blue: #3567c8;
    --admin-blue-soft: rgba(53,103,200,.10);
    --admin-warning: #a86d08;
    --admin-warning-soft: rgba(168,109,8,.11);
    --admin-danger: #bd3c3c;
    --admin-danger-soft: rgba(189,60,60,.10);
    --admin-shadow: 0 16px 45px rgba(15,23,42,.07);
    --admin-shadow-soft: 0 7px 24px rgba(15,23,42,.055);
    --admin-radius: 20px;
    --admin-radius-sm: 13px;

    width: 100%;
    min-height: 100vh;
    padding: 28px;
    box-sizing: border-box;
    background:
      radial-gradient(circle at 8% 0%, rgba(23,107,77,.07), transparent 28rem),
      radial-gradient(circle at 100% 5%, rgba(53,103,200,.06), transparent 25rem),
      var(--admin-bg);
    color: var(--admin-text);
  }

  .admin-redesign *,
  .admin-redesign *::before,
  .admin-redesign *::after {
    box-sizing: border-box;
  }

  .admin-shell {
    width: min(1500px, 100%);
    margin: 0 auto;
  }

  .admin-hero {
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.7);
    border-radius: 28px;
    padding: 28px;
    background:
      linear-gradient(135deg, rgba(255,255,255,.97), rgba(245,250,247,.92));
    box-shadow: var(--admin-shadow);
  }

  .admin-hero::after {
    content: "";
    position: absolute;
    width: 260px;
    height: 260px;
    right: -90px;
    top: -120px;
    border-radius: 50%;
    background: rgba(23,107,77,.08);
    pointer-events: none;
  }

  .admin-hero-content {
    position: relative;
    z-index: 1;
  }

  .admin-hero-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
  }

  .admin-kicker {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 10px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .13em;
    text-transform: uppercase;
    color: var(--admin-primary);
  }

  .admin-kicker::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--admin-primary);
    box-shadow: 0 0 0 5px rgba(23,107,77,.10);
  }

  .admin-title {
    margin: 0;
    font-size: clamp(28px, 4vw, 44px);
    line-height: 1.04;
    letter-spacing: -.035em;
    font-weight: 850;
  }

  .admin-subtitle {
    max-width: 720px;
    margin: 12px 0 0;
    color: var(--admin-muted);
    font-size: 15px;
    line-height: 1.65;
  }

  .admin-cc-badge-new {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 18px;
    padding: 9px 13px;
    border-radius: 999px;
    background: rgba(23,107,77,.08);
    color: var(--admin-primary-dark);
    border: 1px solid rgba(23,107,77,.13);
    font-size: 12px;
    font-weight: 750;
  }

  .admin-cc-badge-new::before {
    content: "●";
    font-size: 8px;
  }

  .admin-hero-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
    flex-shrink: 0;
  }

  .admin-btn {
    min-height: 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid var(--admin-border);
    border-radius: 12px;
    padding: 10px 15px;
    background: rgba(255,255,255,.9);
    color: var(--admin-text);
    text-decoration: none;
    font: inherit;
    font-size: 13px;
    font-weight: 750;
    cursor: pointer;
    transition:
      transform .18s ease,
      box-shadow .18s ease,
      background .18s ease,
      border-color .18s ease;
  }

  .admin-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 8px 20px rgba(15,23,42,.08);
    border-color: rgba(15,23,42,.15);
  }

  .admin-btn:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .admin-btn-primary {
    color: white;
    background: linear-gradient(135deg, var(--admin-primary), #20815c);
    border-color: transparent;
    box-shadow: 0 8px 18px rgba(23,107,77,.18);
  }

  .admin-btn-primary:hover:not(:disabled) {
    background: linear-gradient(135deg, var(--admin-primary-dark), var(--admin-primary));
  }

  .admin-btn-danger {
    color: var(--admin-danger);
    background: var(--admin-danger-soft);
    border-color: rgba(189,60,60,.13);
  }

  .admin-main {
    margin-top: 22px;
  }

  .admin-alert {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    margin-bottom: 16px;
    padding: 14px 16px;
    border-radius: 15px;
    border: 1px solid var(--admin-border);
    background: var(--admin-surface-strong);
    box-shadow: var(--admin-shadow-soft);
    font-size: 14px;
    line-height: 1.5;
  }

  .admin-alert::before {
    content: "";
    width: 8px;
    height: 8px;
    margin-top: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }

  .admin-alert-error {
    color: #8f2929;
    border-color: rgba(189,60,60,.16);
    background: #fff9f9;
  }

  .admin-alert-error::before {
    background: var(--admin-danger);
  }

  .admin-alert-success {
    color: #155b42;
    border-color: rgba(23,107,77,.16);
    background: #f5fbf8;
  }

  .admin-alert-success::before {
    background: var(--admin-primary);
  }

  .admin-tabs {
    position: sticky;
    top: 12px;
    z-index: 20;
    margin-bottom: 20px;
    padding: 6px;
    border: 1px solid rgba(255,255,255,.8);
    border-radius: 17px;
    background: rgba(255,255,255,.82);
    backdrop-filter: blur(18px);
    box-shadow: 0 10px 30px rgba(15,23,42,.07);
  }

  .admin-tabs-current {
    display: none;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    border: 0;
    border-radius: 12px;
    padding: 12px 14px;
    background: transparent;
    color: var(--admin-text);
    font: inherit;
    font-weight: 800;
    cursor: pointer;
  }

  .admin-tabs-list {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .admin-tabs-list::-webkit-scrollbar {
    display: none;
  }

  .admin-tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 40px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 11px;
    padding: 9px 13px;
    background: transparent;
    color: #697487;
    font: inherit;
    font-size: 12px;
    font-weight: 750;
    cursor: pointer;
    transition: all .18s ease;
    white-space: nowrap;
  }

  .admin-tab:hover {
    background: rgba(15,23,42,.045);
    color: var(--admin-text);
  }

  .admin-tab.active {
    background: var(--admin-primary);
    color: white;
    box-shadow: 0 6px 16px rgba(23,107,77,.18);
  }

  .admin-count {
    display: inline-flex;
    min-width: 19px;
    height: 19px;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    border-radius: 999px;
    background: rgba(255,255,255,.18);
    font-size: 10px;
    font-weight: 850;
  }

  .admin-tab:not(.active) .admin-count {
    background: rgba(23,107,77,.09);
    color: var(--admin-primary);
  }

  .admin-section {
    margin-bottom: 20px;
  }

  .admin-section-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 16px;
  }

  .admin-section-heading h2,
  .admin-panel h2,
  .admin-card h3 {
    margin: 0;
    letter-spacing: -.02em;
  }

  .admin-section-heading h2 {
    font-size: 21px;
  }

  .admin-section-heading p,
  .admin-panel p,
  .admin-card p {
    line-height: 1.55;
  }

  .admin-muted {
    color: var(--admin-muted);
  }

  .admin-panel {
    border: 1px solid var(--admin-border);
    border-radius: var(--admin-radius);
    padding: 22px;
    background: var(--admin-surface);
    box-shadow: var(--admin-shadow-soft);
  }

  .admin-panel + .admin-panel {
    margin-top: 18px;
  }

  .admin-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 18px;
    margin-bottom: 18px;
  }

  .admin-panel-title {
    font-size: 20px;
    font-weight: 820;
  }

  .admin-panel-description {
    margin: 6px 0 0;
    color: var(--admin-muted);
    font-size: 13px;
  }

  .admin-stat-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .admin-stat {
    min-width: 0;
    position: relative;
    overflow: hidden;
    border: 1px solid var(--admin-border);
    border-radius: 16px;
    padding: 17px;
    background: linear-gradient(145deg, #fff, #f9fbfa);
  }

  .admin-stat::after {
    content: "";
    position: absolute;
    width: 70px;
    height: 70px;
    right: -35px;
    bottom: -35px;
    border-radius: 50%;
    background: rgba(23,107,77,.055);
  }

  .admin-stat-label {
    display: block;
    color: var(--admin-muted);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .075em;
    text-transform: uppercase;
  }

  .admin-stat-value {
    display: block;
    margin-top: 8px;
    color: var(--admin-text);
    font-size: 22px;
    font-weight: 850;
    letter-spacing: -.025em;
    word-break: break-word;
  }

  .admin-module-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 17px;
  }

  .admin-module {
    display: flex;
    align-items: center;
    gap: 11px;
    min-height: 55px;
    padding: 12px 14px;
    border: 1px solid var(--admin-border);
    border-radius: 14px;
    background: #fff;
    font-size: 13px;
  }

  .admin-module-icon {
    display: inline-flex;
    width: 27px;
    height: 27px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: 9px;
    background: var(--admin-primary-soft);
    color: var(--admin-primary);
    font-weight: 900;
  }

  .admin-module.pending .admin-module-icon {
    background: #f4f5f7;
    color: #89919e;
  }

  .admin-module-note {
    display: block;
    margin-top: 2px;
    color: var(--admin-muted);
    font-size: 11px;
  }

  .admin-toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 18px;
  }

  .admin-search {
    position: relative;
    margin-bottom: 12px;
  }

  .admin-search input {
    width: 100%;
    min-height: 46px;
    padding: 0 15px;
    border: 1px solid var(--admin-border);
    border-radius: 13px;
    outline: none;
    background: #fff;
    color: var(--admin-text);
    font: inherit;
    font-size: 13px;
    transition: border-color .18s ease, box-shadow .18s ease;
  }

  .admin-search input:focus,
  .admin-select:focus {
    border-color: rgba(23,107,77,.4);
    box-shadow: 0 0 0 4px rgba(23,107,77,.08);
  }

  .admin-table-wrap {
    overflow-x: auto;
    border: 1px solid var(--admin-border);
    border-radius: 16px;
    background: #fff;
  }

  .admin-table {
    width: 100%;
    min-width: 920px;
    border-collapse: collapse;
  }

  .admin-table th {
    padding: 12px 14px;
    border-bottom: 1px solid var(--admin-border);
    background: #f8faf9;
    color: #77808e;
    font-size: 10px;
    font-weight: 850;
    letter-spacing: .07em;
    text-align: left;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .admin-table td {
    padding: 14px;
    border-bottom: 1px solid rgba(15,23,42,.055);
    color: var(--admin-text);
    font-size: 12px;
    vertical-align: top;
  }

  .admin-table tbody tr:last-child td {
    border-bottom: 0;
  }

  .admin-table tbody tr:hover {
    background: rgba(23,107,77,.018);
  }

  .admin-select {
    min-height: 38px;
    max-width: 190px;
    padding: 7px 10px;
    border: 1px solid var(--admin-border);
    border-radius: 10px;
    outline: none;
    background: #fff;
    color: var(--admin-text);
    font: inherit;
    font-size: 12px;
  }

  .admin-user-name {
    font-weight: 800;
  }

  .admin-user-meta {
    margin-top: 3px;
    color: var(--admin-muted);
    font-size: 11px;
  }

  .admin-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .admin-chip {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 4px 8px;
    border-radius: 999px;
    background: #f1f4f3;
    color: #53605c;
    font-size: 10px;
    font-weight: 800;
  }

  .admin-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 25px;
    padding: 4px 9px;
    border-radius: 999px;
    background: #f0f2f4;
    color: #59636e;
    font-size: 10px;
    font-weight: 850;
    white-space: nowrap;
  }

  .admin-status::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }

  .admin-status.good {
    color: #14724f;
    background: #eaf7f1;
  }

  .admin-status.warn {
    color: #9b690e;
    background: #fff5dc;
  }

  .admin-status.bad {
    color: #ad3939;
    background: #fff0f0;
  }

  .admin-action-row {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }

  .admin-mini-btn {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--admin-border);
    border-radius: 9px;
    padding: 7px 10px;
    background: #fff;
    color: var(--admin-text);
    font: inherit;
    font-size: 11px;
    font-weight: 750;
    cursor: pointer;
  }

  .admin-mini-btn:hover:not(:disabled) {
    border-color: rgba(23,107,77,.25);
    background: #f7fbf9;
  }

  .admin-mini-btn.primary {
    color: #fff;
    border-color: transparent;
    background: var(--admin-primary);
  }

  .admin-mini-btn.danger {
    color: var(--admin-danger);
    background: var(--admin-danger-soft);
    border-color: transparent;
  }

  .admin-mini-btn:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .admin-role-control {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 180px;
  }

  .admin-card-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }

  .admin-card {
    min-width: 0;
    border: 1px solid var(--admin-border);
    border-radius: 18px;
    padding: 18px;
    background: var(--admin-surface-strong);
    box-shadow: var(--admin-shadow-soft);
  }

  .admin-card h3 {
    font-size: 16px;
  }

  .admin-card p {
    margin: 8px 0;
    color: var(--admin-muted);
    font-size: 12px;
  }

  .admin-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 15px;
  }

  .admin-card-media {
    width: 100%;
    max-height: 175px;
    object-fit: cover;
    border-radius: 13px;
    margin-bottom: 12px;
    border: 1px solid var(--admin-border);
  }

  .admin-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .admin-empty {
    padding: 30px 20px;
    text-align: center;
    color: var(--admin-muted);
    border: 1px dashed rgba(15,23,42,.13);
    border-radius: 16px;
    background: rgba(255,255,255,.6);
  }

  .admin-empty-icon {
    display: flex;
    width: 42px;
    height: 42px;
    margin: 0 auto 10px;
    align-items: center;
    justify-content: center;
    border-radius: 13px;
    background: var(--admin-primary-soft);
    color: var(--admin-primary);
    font-size: 18px;
  }

  .admin-code {
    padding: 3px 6px;
    border-radius: 6px;
    background: #f2f4f5;
    color: #58636e;
    font-size: 10px;
  }

  .admin-dialog {
    width: min(900px, calc(100% - 28px));
    max-width: 900px;
    border: 0;
    padding: 0;
    border-radius: 24px;
    background: transparent;
  }

  .admin-dialog::backdrop {
    background: rgba(10,17,24,.52);
    backdrop-filter: blur(5px);
  }

  .admin-modal {
    position: relative;
    padding: 26px;
    border: 1px solid rgba(255,255,255,.65);
    border-radius: 24px;
    background: #fff;
    box-shadow: 0 30px 80px rgba(0,0,0,.2);
  }

  .admin-modal-close {
    position: absolute;
    top: 13px;
    right: 13px;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 11px;
    background: #f2f4f5;
    color: #59636d;
    font-size: 22px;
    cursor: pointer;
  }

  .admin-loading {
    min-height: 70vh;
    display: grid;
    place-items: center;
    padding: 28px;
  }

  .admin-loading-card {
    width: min(520px, 100%);
    padding: 30px;
    border: 1px solid var(--admin-border);
    border-radius: 24px;
    background: rgba(255,255,255,.9);
    box-shadow: var(--admin-shadow);
    text-align: center;
  }

  .admin-spinner {
    width: 42px;
    height: 42px;
    margin: 0 auto 17px;
    border: 3px solid rgba(23,107,77,.12);
    border-top-color: var(--admin-primary);
    border-radius: 50%;
    animation: admin-spin .8s linear infinite;
  }

  @keyframes admin-spin {
    to { transform: rotate(360deg); }
  }

  .admin-workspace > .admin-section-heading {
    margin-bottom: 18px;
  }

  .admin-financial-grid {
    margin-bottom: 20px;
  }

  .admin-financial-grid .admin-stat-value {
    font-size: 20px;
  }

  .admin-divider-label {
    display: inline-flex;
    margin-bottom: 8px;
    color: var(--admin-primary);
    font-size: 10px;
    font-weight: 850;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  .admin-details {
    margin-top: 8px;
  }

  .admin-details summary {
    cursor: pointer;
    color: var(--admin-primary);
    font-size: 11px;
    font-weight: 750;
  }

  .admin-warning-note {
    padding: 11px 13px;
    margin-top: 12px;
    border-radius: 11px;
    background: var(--admin-warning-soft);
    color: #80570c;
    font-size: 11px;
    line-height: 1.5;
  }

  .admin-ad-destination {
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  .admin-mobile-summary {
    display: none;
  }

  @media (max-width: 1100px) {
    .admin-redesign {
      padding: 20px;
    }

    .admin-stat-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .admin-card-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 800px) {
    .admin-redesign {
      padding: 14px;
    }

    .admin-hero {
      padding: 21px;
      border-radius: 22px;
    }

    .admin-hero-top {
      flex-direction: column;
    }

    .admin-hero-actions {
      justify-content: flex-start;
      width: 100%;
    }

    .admin-tabs {
      padding: 5px;
    }

    .admin-tabs-current {
      display: flex;
    }

    .admin-tabs-list {
      display: none;
      flex-direction: column;
      padding: 5px;
      border-top: 1px solid var(--admin-border);
    }

    .admin-tabs-open .admin-tabs-list {
      display: flex;
    }

    .admin-tab {
      justify-content: space-between;
      width: 100%;
    }

    .admin-stat-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .admin-module-grid {
      grid-template-columns: 1fr;
    }

    .admin-card-grid {
      grid-template-columns: 1fr;
    }

    .admin-toolbar,
    .admin-panel-header,
    .admin-section-heading {
      flex-direction: column;
      align-items: stretch;
    }

    .admin-panel {
      padding: 17px;
      border-radius: 18px;
    }
  }

  @media (max-width: 560px) {
    .admin-redesign {
      padding: 9px;
    }

    .admin-title {
      font-size: 28px;
    }

    .admin-subtitle {
      font-size: 13px;
    }

    .admin-hero-actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    .admin-btn {
      width: 100%;
    }

    .admin-stat-grid {
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .admin-stat {
      padding: 13px;
      border-radius: 13px;
    }

    .admin-stat-value {
      font-size: 18px;
    }

    .admin-stat-label {
      font-size: 9px;
    }

    .admin-panel {
      padding: 14px;
    }

    .admin-table-wrap {
      overflow: visible;
      border: 0;
      background: transparent;
    }

    .admin-table {
      min-width: 0;
      display: block;
    }

    .admin-table thead {
      display: none;
    }

    .admin-table tbody,
    .admin-table tr,
    .admin-table td {
      display: block;
      width: 100%;
    }

    .admin-table tr {
      margin-bottom: 12px;
      padding: 10px;
      border: 1px solid var(--admin-border);
      border-radius: 15px;
      background: #fff;
      box-shadow: 0 5px 18px rgba(15,23,42,.04);
    }

    .admin-table td {
      display: grid;
      grid-template-columns: 105px minmax(0, 1fr);
      gap: 10px;
      padding: 9px 7px;
      border-bottom: 1px solid rgba(15,23,42,.055);
      font-size: 12px;
    }

    .admin-table td:last-child {
      border-bottom: 0;
    }

    .admin-table td::before {
      content: attr(data-label);
      color: #7b8491;
      font-size: 9px;
      font-weight: 850;
      letter-spacing: .06em;
      text-transform: uppercase;
    }

    .admin-table td[data-label=""]::before {
      content: "";
    }

    .admin-table .admin-action-row,
    .admin-table .admin-role-control,
    .admin-table .admin-chip-row {
      min-width: 0;
    }

    .admin-select {
      max-width: none;
      width: 100%;
    }

    .admin-mini-btn {
      width: 100%;
    }

    .admin-role-control {
      width: 100%;
    }

    .admin-mobile-summary {
      display: block;
      margin-top: 4px;
      color: var(--admin-muted);
      font-size: 11px;
    }

    .admin-card {
      padding: 15px;
    }

    .admin-modal {
      padding: 20px;
      border-radius: 19px;
    }
  }
`;

function StatusBadge({ status }) {
  const normalized = String(status || '').toUpperCase();

  let type = 'default';

  if (
    [
      'VERIFIED',
      'ACTIVE',
      'APPROVED',
      'PUBLISHED',
      'SCHEDULED',
      'RESOLVED',
    ].includes(normalized)
  ) {
    type = 'good';
  }

  if (
    ['REJECTED', 'SUSPENDED', 'CANCELLED'].includes(normalized) ||
    normalized === 'RECONCILIATION_REQUIRED'
  ) {
    type = 'bad';
  }

  if (
    [
      'PENDING',
      'PENDING_PAYMENT',
      'PAID_PENDING_REVIEW',
      'EXPIRED',
    ].includes(normalized)
  ) {
    type = 'warn';
  }

  return (
    <span className={`admin-status ${type}`}>
      {String(status || 'UNKNOWN').replace(/_/g, ' ')}
    </span>
  );
}

function EmptyState({ children }) {
  return (
    <div className="admin-empty">
      <div className="admin-empty-icon">✓</div>
      {children}
    </div>
  );
}

export default function AdminDashboard() {
  const { user } = useAuth();

  const [tab, setTab] = useState('overview');
  const [tabMenuOpen, setTabMenuOpen] = useState(false);

  const performanceModalRef = useRef(null);
  const tabsNavRef = useRef(null);

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [suspiciousUsers, setSuspiciousUsers] = useState([]);
  const [ads, setAds] = useState([]);
  const [payments, setPayments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [commissionSummary, setCommissionSummary] = useState(null);
  const [operations, setOperations] = useState(null);
  const [orderEvents, setOrderEvents] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);

  const [userSearch, setUserSearch] = useState('');
  const [roleSelections, setRoleSelections] = useState({});

  const [error, setError] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    setMfaRequired(false);

    try {
      const [
        overviewRes,
        usersRes,
        disputesRes,
        fraudRes,
        adsRes,
        paymentsRes,
        commissionRes,
        ordersRes,
        operationsRes,
        orderEventsRes,
        auditEventsRes,
      ] = await Promise.all([
        api.get('/admin/overview'),
        api.get('/admin/users'),
        api.get('/disputes'),
        api.get('/admin/fraud-flags'),
        api.get('/ads'),
        api.get('/payments', {
          params: {
            status: ['PENDING', 'RECONCILIATION_REQUIRED'],
          },
        }),
        api.get('/payments/commissions/summary'),
        api.get('/orders'),
        api.get('/admin/operations/summary'),
        api.get('/admin/order-events', { params: { limit: 100 } }),
        api.get('/admin/audit-events', { params: { limit: 100 } }),
      ]);

      setOverview(overviewRes.data);
      setUsers(usersRes.data?.users || []);
      setDisputes(disputesRes.data?.disputes || []);
      setSuspiciousUsers(fraudRes.data?.suspiciousUsers || []);
      setAds(adsRes.data?.ads || []);
      setPayments(paymentsRes.data?.payments || []);
      setCommissionSummary(commissionRes.data);
      setOrders(ordersRes.data?.orders || []);
      setOperations(operationsRes.data || null);
      setOrderEvents(orderEventsRes.data?.events || []);
      setAuditEvents(auditEventsRes.data?.events || []);
    } catch (err) {
      if (err.response?.data?.code === 'MFA_SETUP_REQUIRED') {
        setMfaRequired(true);
      } else {
        setError(
          err.response?.data?.error ||
            'Could not load admin data'
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!tabMenuOpen) return undefined;

    function handleOutsideClick(event) {
      if (
        tabsNavRef.current &&
        !tabsNavRef.current.contains(event.target)
      ) {
        setTabMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [tabMenuOpen]);

  function clearMessages() {
    setError('');
    setSuccess('');
  }

  async function resolveDispute(id, status) {
    clearMessages();
    setActionLoading(`dispute-${id}`);

    try {
      await api.patch(`/disputes/${id}/resolve`, {
        status,
        resolution: `Marked ${status} by admin`,
      });

      setSuccess(`Dispute ${status.toLowerCase()} successfully.`);
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not resolve dispute'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function cancelOrder(order) {
    clearMessages();

    const confirmed = window.confirm(
      `Cancel order ${order.id.slice(
        0,
        8
      )}? This cannot be undone. The listing becomes available again and any completed payments are flagged for refund.`
    );

    if (!confirmed) return;

    setActionLoading(`order-${order.id}`);

    try {
      await api.patch(`/orders/${order.id}/cancel`, {
        reason: 'Cancelled by admin',
      });

      setSuccess('Order cancelled.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not cancel order'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function setVerification(userId, verificationStatus) {
    clearMessages();
    setActionLoading(`verify-${userId}`);

    try {
      await api.patch(
        `/admin/users/${userId}/verify`,
        { verificationStatus }
      );

      setSuccess(
        'Verification status updated successfully.'
      );
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not update verification status'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function setAccountStatus(userId, accountStatus) {
    clearMessages();

    const selectedUser = users.find(
      (item) => item.id === userId
    );

    if (!selectedUser) return;

    const action =
      accountStatus === 'SUSPENDED'
        ? 'suspend'
        : 'activate';

    const confirmed = window.confirm(
      `Are you sure you want to ${action} ${
        selectedUser.name || selectedUser.email
      }?`
    );

    if (!confirmed) return;

    setActionLoading(`status-${userId}`);

    try {
      await api.patch(
        `/admin/users/${userId}/status`,
        { accountStatus }
      );

      setSuccess(
        accountStatus === 'SUSPENDED'
          ? 'User account suspended successfully.'
          : 'User account activated successfully.'
      );

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not update account status'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function addRole(userId) {
    clearMessages();

    const role = roleSelections[userId];

    if (!role) {
      setError('Select a role first.');
      return;
    }

    setActionLoading(`add-role-${userId}`);

    try {
      await api.patch(
        `/admin/users/${userId}/roles/add`,
        { role }
      );

      setSuccess(`${role} role added successfully.`);

      setRoleSelections((current) => ({
        ...current,
        [userId]: '',
      }));

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not add role'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function removeRole(userId, role) {
    clearMessages();

    const selectedUser = users.find(
      (item) => item.id === userId
    );

    if (!selectedUser) return;

    const confirmed = window.confirm(
      `Remove ${role} role from ${
        selectedUser.name || selectedUser.email
      }?`
    );

    if (!confirmed) return;

    setActionLoading(
      `remove-role-${userId}-${role}`
    );

    try {
      await api.patch(
        `/admin/users/${userId}/roles/remove`,
        { role }
      );

      setSuccess(`${role} role removed successfully.`);
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not remove role'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function markTelegramPublished(adId) {
    clearMessages();

    const postReference =
      window.prompt(
        'Telegram post reference/link (optional):'
      ) || undefined;

    setActionLoading(`ad-${adId}`);

    try {
      await api.patch(
        `/ads/${adId}/telegram-publication`,
        { postReference }
      );

      setSuccess('Telegram publication recorded.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not record Telegram publication'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function cancelAdCampaign(adId) {
    clearMessages();

    if (
      !window.confirm(
        'Cancel this campaign? Any paid amount is flagged REFUNDED as a bookkeeping record.'
      )
    ) {
      return;
    }

    const reason =
      window.prompt(
        'Reason for cancelling this campaign (optional):'
      ) || undefined;

    setActionLoading(`ad-${adId}`);

    try {
      await api.patch(`/ads/${adId}/cancel`, {
        reason,
      });

      setSuccess('Campaign cancelled.');
      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not cancel campaign'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function setAdStatus(adId, status) {
    clearMessages();
    setActionLoading(`ad-${adId}`);

    try {
      let rejectionReason;

      if (status === 'REJECTED') {
        rejectionReason =
          window.prompt(
            'Reason for rejecting this campaign (optional):'
          ) || undefined;
      }

      await api.patch(`/ads/${adId}/status`, {
        status,
        rejectionReason,
      });

      setSuccess(
        `Campaign ${status.toLowerCase()} successfully.`
      );

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not update campaign status'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function confirmPayment(paymentId) {
    clearMessages();
    setActionLoading(`payment-${paymentId}`);

    try {
      await api.patch(
        `/payments/${paymentId}/confirm`
      );

      setSuccess(
        'Payment confirmed and reconciled.'
      );

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not confirm payment'
      );
    } finally {
      setActionLoading('');
    }
  }

  async function checkGatewayPayment(
    paymentId,
    provider
  ) {
    clearMessages();
    setActionLoading(`payment-${paymentId}`);

    try {
      const response = await api.get(
        `/payments/${paymentId}/${provider}/verify`
      );

      setSuccess(
        response.data?.status === 'PAID'
          ? 'Payment confirmed by the gateway and reconciled.'
          : `Gateway reports this payment as ${
              response.data?.status ||
              'not yet completed'
            } — nothing to reconcile yet.`
      );

      await loadAll();
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Could not check payment with the gateway'
      );
    } finally {
      setActionLoading('');
    }
  }

  const filteredUsers = useMemo(() => {
    const search = userSearch.trim().toLowerCase();

    if (!search) return users;

    return users.filter((item) => {
      const searchableText = [
        item.name,
        item.email,
        item.phone,
        item.location,
        ...(item.roles || []),
        item.verificationStatus,
        item.accountStatus,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchableText.includes(search);
    });
  }, [users, userSearch]);

  if (loading && !overview) {
    return (
      <div className="admin-redesign">
        <style>{ADMIN_STYLES}</style>

        <div className="admin-shell admin-loading">
          <div className="admin-loading-card">
            <div className="admin-spinner" />
            <div className="admin-kicker">
              MARKETBRIDGE ADMIN
            </div>
            <h1 className="admin-title">
              Loading control center
            </h1>
            <p className="admin-subtitle">
              {error ||
                'Preparing your marketplace administration workspace…'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const cards = overview
    ? [
        ['Users', overview.users],
        ['Listings', overview.listings],
        ['Orders', overview.orders],
        ['Open disputes', overview.openDisputes],
        ['Active ads', overview.activeAds],
        [
          'Suspended users',
          overview.suspendedUsers || 0,
        ],
        [
          'Paid volume',
          `${Number(
            overview.totalPaidVolume || 0
          ).toLocaleString()} ETB`,
        ],
      ]
    : [];

  const openDisputes = disputes.filter(
    (d) => d.status === 'OPEN'
  );

  const resolvedDisputes = disputes.filter(
    (d) => d.status !== 'OPEN'
  );

  const pendingAds = ads.filter(
    (a) =>
      a.status === 'PAID_PENDING_REVIEW' ||
      (a.status === 'PENDING' &&
        [
          'BANNER',
          'TELEGRAM_PROMOTION',
        ].includes(a.type))
  );

  const reviewedAds = ads.filter(
    (a) =>
      !pendingAds.some(
        (pending) => pending.id === a.id
      )
  );

  const tabItems = [
    {
      key: 'overview',
      label: 'Overview',
      count: 0,
    },
    {
      key: 'users',
      label: 'Users & Control',
      count: 0,
    },
    {
      key: 'disputes',
      label: 'Disputes',
      count: openDisputes.length,
    },
    {
      key: 'fraud',
      label: 'Fraud Monitoring',
      count: suspiciousUsers.length,
    },
    {
      key: 'advertising',
      label: 'Advertising',
      count: pendingAds.length,
    },
    {
      key: 'orders',
      label: 'Orders',
      count: orders.length,
    },
    {
      key: 'payments',
      label: 'Payments',
      count: payments.length,
    },
    {
      key: 'operations',
      label: 'Operations & Audit',
      count:
        (operations?.queues
          ?.reconciliationPayments || 0) +
        (operations?.queues?.openDisputes || 0),
    },
  ];

  const activeTabItem =
    tabItems.find((item) => item.key === tab) ||
    tabItems[0];

  if (mfaRequired) {
    return (
      <div className="admin-redesign">
        <style>{ADMIN_STYLES}</style>

        <div className="admin-shell">
          <section className="admin-hero">
            <div className="admin-hero-content">
              <DashboardWelcome
                user={user}
                subtitle="Manage users, verification, account access, roles, disputes, and fraud monitoring."
              />

              <div className="admin-cc-badge-new">
                Protected administration workspace
              </div>
            </div>
          </section>

          <section
            className="admin-panel"
            style={{ marginTop: 20, maxWidth: 650 }}
          >
            <div className="admin-kicker">
              SECURITY REQUIRED
            </div>

            <h2 className="admin-panel-title">
              Set up MFA to continue
            </h2>

            <p className="admin-panel-description">
              Admin actions on MarketBridge now require
              multi-factor authentication. This takes
              about a minute with an authenticator app
              such as Google Authenticator or Authy.
            </p>

            <div style={{ marginTop: 18 }}>
              <Link
                to="/account/security"
                className="admin-btn admin-btn-primary"
              >
                Set up MFA
              </Link>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-redesign">
      <style>{ADMIN_STYLES}</style>

      <div className="admin-shell">
        <section className="admin-hero">
          <div className="admin-hero-content">
            <div className="admin-hero-top">
              <div>
                <div className="admin-kicker">
                  MARKETBRIDGE CONTROL CENTER
                </div>

                <h1 className="admin-title">
                  Administration, simplified.
                </h1>

                <p className="admin-subtitle">
                  Manage marketplace users, verification,
                  disputes, fraud signals, advertising,
                  orders, payments, and operational events
                  from one secure workspace.
                </p>

                <div className="admin-cc-badge-new">
                  Control Center · Admin access
                </div>
              </div>

              <div className="admin-hero-actions">
                <RoleSwitchCTA current="ADMIN" />

                <button
                  type="button"
                  className="admin-btn admin-btn-primary"
                  onClick={() =>
                    performanceModalRef.current?.showModal()
                  }
                >
                  Performance
                </button>

                <Link
                  to="/account/security"
                  className="admin-btn"
                >
                  Account security
                </Link>
              </div>
            </div>
          </div>
        </section>

        <dialog
          ref={performanceModalRef}
          className="admin-dialog"
        >
          <div className="admin-modal">
            <button
              type="button"
              className="admin-modal-close"
              aria-label="Close performance dialog"
              onClick={() =>
                performanceModalRef.current?.close()
              }
            >
              ×
            </button>

            <div className="admin-kicker">
              MARKETPLACE SNAPSHOT
            </div>

            <h2 className="admin-panel-title">
              Marketplace performance
            </h2>

            <p className="admin-panel-description">
              Current platform-level figures from the
              administration overview.
            </p>

            <div
              className="admin-stat-grid"
              style={{ marginTop: 18 }}
            >
              {cards.map(([label, value]) => (
                <div
                  className="admin-stat"
                  key={label}
                >
                  <span className="admin-stat-label">
                    {label}
                  </span>
                  <b className="admin-stat-value">
                    {value}
                  </b>
                </div>
              ))}
            </div>
          </div>
        </dialog>

        <main className="admin-main">
          {error && (
            <div className="admin-alert admin-alert-error">
              {error}
            </div>
          )}

          {success && (
            <div className="admin-alert admin-alert-success">
              {success}
            </div>
          )}

          <nav
            className={`admin-tabs ${
              tabMenuOpen ? 'admin-tabs-open' : ''
            }`}
            ref={tabsNavRef}
            aria-label="Admin dashboard sections"
          >
            <button
              type="button"
              className="admin-tabs-current"
              aria-expanded={tabMenuOpen}
              onClick={() =>
                setTabMenuOpen((open) => !open)
              }
            >
              <span>
                {activeTabItem.label}

                {activeTabItem.count > 0 && (
                  <span
                    className="admin-count"
                    style={{ marginLeft: 7 }}
                  >
                    {activeTabItem.count}
                  </span>
                )}
              </span>

              <span>
                {tabMenuOpen ? '⌃' : '⌄'}
              </span>
            </button>

            <div className="admin-tabs-list">
              {tabItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`admin-tab ${
                    tab === item.key ? 'active' : ''
                  }`}
                  onClick={() => {
                    clearMessages();
                    setTab(item.key);
                    setTabMenuOpen(false);
                  }}
                >
                  {item.label}

                  {item.count > 0 && (
                    <span className="admin-count">
                      {item.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </nav>

          {tab === 'overview' && (
            <section className="admin-section">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">
                    PLATFORM HEALTH
                  </div>

                  <h2>Marketplace overview</h2>

                  <p className="admin-muted">
                    A quick view of the systems currently
                    available to administration.
                  </p>
                </div>

                <button
                  type="button"
                  className="admin-btn"
                  onClick={loadAll}
                  disabled={loading}
                >
                  {loading
                    ? 'Refreshing…'
                    : 'Refresh data'}
                </button>
              </div>

              <div className="admin-stat-grid">
                {cards.map(([label, value]) => (
                  <div
                    className="admin-stat"
                    key={label}
                  >
                    <span className="admin-stat-label">
                      {label}
                    </span>

                    <b className="admin-stat-value">
                      {value}
                    </b>
                  </div>
                ))}
              </div>

              <div
                className="admin-panel"
                style={{ marginTop: 18 }}
              >
                <div className="admin-panel-header">
                  <div>
                    <h2 className="admin-panel-title">
                      Modules status
                    </h2>

                    <p className="admin-panel-description">
                      Current administration capabilities
                      and implementation visibility.
                    </p>
                  </div>
                </div>

                <div className="admin-module-grid">
                  {[
                    [
                      'Users & role management',
                      true,
                    ],
                    [
                      'Verification management',
                      true,
                    ],
                    [
                      'Account suspension / activation',
                      true,
                    ],
                    [
                      'Sellers / buyers / inspectors / truck owners',
                      true,
                    ],
                    ['Disputes & reports', true],
                    ['Fraud flags (heuristic)', true],
                    [
                      'Listings & categories moderation',
                      false,
                    ],
                    [
                      'Orders & payments oversight',
                      true,
                    ],
                    [
                      'Transport jobs oversight',
                      false,
                    ],
                    [
                      'Advertising & sponsored listings approval',
                      true,
                    ],
                    [
                      'Commissions & revenue records',
                      true,
                    ],
                  ].map(([label, built]) => (
                    <div
                      className={`admin-module ${
                        built ? '' : 'pending'
                      }`}
                      key={label}
                    >
                      <span className="admin-module-icon">
                        {built ? '✓' : '○'}
                      </span>

                      <div>
                        <strong>{label}</strong>

                        {!built && (
                          <span className="admin-module-note">
                            Backend not built yet
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {tab === 'users' && (
            <section className="admin-section">
              <div className="admin-panel">
                <div className="admin-toolbar">
                  <div>
                    <div className="admin-kicker">
                      USER ADMINISTRATION
                    </div>

                    <h2 className="admin-panel-title">
                      Users & account control
                    </h2>

                    <p className="admin-panel-description">
                      Search users, manage verification,
                      activate or suspend accounts, and
                      manage marketplace roles.
                    </p>
                  </div>

                  <button
                    type="button"
                    className="admin-btn"
                    onClick={loadAll}
                    disabled={loading}
                  >
                    {loading
                      ? 'Refreshing…'
                      : 'Refresh'}
                  </button>
                </div>

                <div className="admin-search">
                  <input
                    type="search"
                    value={userSearch}
                    onChange={(event) =>
                      setUserSearch(event.target.value)
                    }
                    placeholder="Search by name, email, phone, role, status..."
                  />
                </div>

                <p className="admin-muted">
                  Showing{' '}
                  <strong>
                    {filteredUsers.length}
                  </strong>{' '}
                  of{' '}
                  <strong>{users.length}</strong>{' '}
                  users.
                </p>

                <div
                  className="admin-table-wrap"
                  style={{ marginTop: 14 }}
                >
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Roles</th>
                        <th>Rating</th>
                        <th>Verification</th>
                        <th>Account</th>
                        <th>Role control</th>
                      </tr>
                    </thead>

                    <tbody>
                      {filteredUsers.map(
                        (item) => {
                          const isActionLoading =
                            actionLoading.includes(
                              item.id
                            );

                          return (
                            <tr key={item.id}>
                              <td data-label="Name">
                                <div className="admin-user-name">
                                  {item.name ||
                                    'Unnamed user'}
                                </div>

                                {item.phone && (
                                  <div className="admin-user-meta">
                                    {item.phone}
                                  </div>
                                )}

                                {item.location && (
                                  <div className="admin-user-meta">
                                    {item.location}
                                  </div>
                                )}
                              </td>

                              <td data-label="Email">
                                {item.email}
                              </td>

                              <td data-label="Roles">
                                <div className="admin-chip-row">
                                  {(item.roles || []).map(
                                    (role) => (
                                      <span
                                        className="admin-chip"
                                        key={role}
                                      >
                                        {role}
                                      </span>
                                    )
                                  )}
                                </div>
                              </td>

                              <td data-label="Rating">
                                <strong>
                                  {Number(
                                    item.rating || 0
                                  ).toFixed(1)}
                                </strong>
                              </td>

                              <td data-label="Verification">
                                <select
                                  className="admin-select"
                                  value={
                                    item.verificationStatus ||
                                    'UNVERIFIED'
                                  }
                                  onChange={(event) =>
                                    setVerification(
                                      item.id,
                                      event.target.value
                                    )
                                  }
                                  disabled={
                                    isActionLoading
                                  }
                                >
                                  <option value="UNVERIFIED">
                                    UNVERIFIED
                                  </option>

                                  {VERIFICATION_OPTIONS.map(
                                    (option) => (
                                      <option
                                        key={option}
                                        value={option}
                                      >
                                        {option}
                                      </option>
                                    )
                                  )}
                                </select>
                              </td>

                              <td data-label="Account">
                                <div className="admin-action-row">
                                  <StatusBadge
                                    status={
                                      item.accountStatus ||
                                      'ACTIVE'
                                    }
                                  />

                                  {item.accountStatus ===
                                  'SUSPENDED' ? (
                                    <button
                                      type="button"
                                      className="admin-mini-btn primary"
                                      disabled={
                                        isActionLoading
                                      }
                                      onClick={() =>
                                        setAccountStatus(
                                          item.id,
                                          'ACTIVE'
                                        )
                                      }
                                    >
                                      {isActionLoading
                                        ? 'Working…'
                                        : 'Activate'}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="admin-mini-btn"
                                      disabled={
                                        isActionLoading
                                      }
                                      onClick={() =>
                                        setAccountStatus(
                                          item.id,
                                          'SUSPENDED'
                                        )
                                      }
                                    >
                                      {isActionLoading
                                        ? 'Working…'
                                        : 'Suspend'}
                                    </button>
                                  )}
                                </div>
                              </td>

                              <td data-label="Role control">
                                <div className="admin-role-control">
                                  <select
                                    className="admin-select"
                                    value={
                                      roleSelections[
                                        item.id
                                      ] || ''
                                    }
                                    onChange={(event) =>
                                      setRoleSelections(
                                        (current) => ({
                                          ...current,
                                          [item.id]:
                                            event.target
                                              .value,
                                        })
                                      )
                                    }
                                    disabled={
                                      isActionLoading
                                    }
                                  >
                                    <option value="">
                                      Select role...
                                    </option>

                                    {ROLE_OPTIONS.map(
                                      (role) => (
                                        <option
                                          key={role}
                                          value={role}
                                        >
                                          {role}
                                        </option>
                                      )
                                    )}
                                  </select>

                                  <button
                                    type="button"
                                    className="admin-mini-btn primary"
                                    disabled={
                                      isActionLoading ||
                                      !roleSelections[
                                        item.id
                                      ]
                                    }
                                    onClick={() =>
                                      addRole(item.id)
                                    }
                                  >
                                    Add role
                                  </button>

                                  {(item.roles || [])
                                    .length > 0 && (
                                    <div className="admin-chip-row">
                                      {item.roles.map(
                                        (role) => (
                                          <button
                                            type="button"
                                            key={role}
                                            className="admin-mini-btn"
                                            disabled={
                                              isActionLoading
                                            }
                                            onClick={() =>
                                              removeRole(
                                                item.id,
                                                role
                                              )
                                            }
                                          >
                                            Remove {role}
                                          </button>
                                        )
                                      )}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        }
                      )}

                      {filteredUsers.length === 0 && (
                        <tr>
                          <td
                            colSpan="7"
                            data-label="Users"
                          >
                            <EmptyState>
                              No users found matching
                              your search.
                            </EmptyState>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {tab === 'disputes' && (
            <section className="admin-section">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">
                    MODERATION
                  </div>
                  <h2>Open disputes</h2>
                  <p className="admin-muted">
                    Review active marketplace disputes
                    and record the administrative
                    resolution.
                  </p>
                </div>
              </div>

              <div className="admin-card-grid">
                {openDisputes.map((item) => (
                  <div
                    className="admin-card"
                    key={item.id}
                  >
                    <div className="admin-card-top">
                      <h3>
                        {item.disputeType}
                      </h3>
                      <StatusBadge status="OPEN" />
                    </div>

                    <p>
                      <strong>
                        {item.raisedBy?.name ||
                          'Unknown'}
                      </strong>{' '}
                      vs{' '}
                      <strong>
                        {item.against?.name ||
                          'Unknown'}
                      </strong>
                    </p>

                    <p>{item.description}</p>

                    <div className="admin-card-actions">
                      <button
                        type="button"
                        className="admin-mini-btn primary"
                        disabled={
                          actionLoading ===
                          `dispute-${item.id}`
                        }
                        onClick={() =>
                          resolveDispute(
                            item.id,
                            'RESOLVED'
                          )
                        }
                      >
                        {actionLoading ===
                        `dispute-${item.id}`
                          ? 'Working…'
                          : 'Resolve'}
                      </button>

                      <button
                        type="button"
                        className="admin-mini-btn danger"
                        disabled={
                          actionLoading ===
                          `dispute-${item.id}`
                        }
                        onClick={() =>
                          resolveDispute(
                            item.id,
                            'REJECTED'
                          )
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}

                {openDisputes.length === 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <EmptyState>
                      No open disputes right now.
                    </EmptyState>
                  </div>
                )}
              </div>

              <div
                className="admin-panel"
                style={{ marginTop: 20 }}
              >
                <div className="admin-panel-header">
                  <div>
                    <div className="admin-kicker">
                      HISTORY
                    </div>
                    <h2 className="admin-panel-title">
                      Recently resolved
                    </h2>
                  </div>
                </div>

                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Parties</th>
                        <th>Status</th>
                      </tr>
                    </thead>

                    <tbody>
                      {resolvedDisputes
                        .slice(0, 10)
                        .map((item) => (
                          <tr key={item.id}>
                            <td data-label="Type">
                              <strong>
                                {item.disputeType}
                              </strong>
                            </td>

                            <td data-label="Parties">
                              <span className="admin-muted">
                                {item.raisedBy?.name ||
                                  'Unknown'}{' '}
                                vs{' '}
                                {item.against?.name ||
                                  'Unknown'}
                              </span>
                            </td>

                            <td data-label="Status">
                              <StatusBadge
                                status={item.status}
                              />
                            </td>
                          </tr>
                        ))}

                      {resolvedDisputes.length === 0 && (
                        <tr>
                          <td
                            colSpan="3"
                            data-label="History"
                          >
                            <EmptyState>
                              Nothing has been resolved
                              yet.
                            </EmptyState>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {tab === 'fraud' && (
            <section className="admin-section">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">
                    RISK MONITORING
                  </div>

                  <h2>Flagged users</h2>

                  <p className="admin-muted">
                    Users with multiple open disputes
                    filed against them. This is a starting
                    heuristic — not a conclusive fraud
                    finding.
                  </p>
                </div>
              </div>

              <div className="admin-card-grid">
                {suspiciousUsers.map((item) => (
                  <div
                    className="admin-card"
                    key={item.id}
                  >
                    <div className="admin-card-top">
                      <h3>
                        {item.name ||
                          'Unnamed user'}
                      </h3>

                      <span className="admin-status warn">
                        Review
                      </span>
                    </div>

                    <p>
                      {item.email}
                    </p>

                    <p>
                      {(item.disputesAgainst || [])
                        .length}{' '}
                      open dispute(s) against this
                      account.
                    </p>

                    {(item.disputesAgainst || []).map(
                      (dispute) => (
                        <p key={dispute.id}>
                          —{' '}
                          <strong>
                            {dispute.disputeType}
                          </strong>
                          : {dispute.description}
                        </p>
                      )
                    )}
                  </div>
                ))}

                {suspiciousUsers.length === 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <EmptyState>
                      No flagged users right now.
                    </EmptyState>
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === 'advertising' && (
            <section className="admin-section">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">
                    ADVERTISING
                  </div>

                  <h2>Campaign control</h2>

                  <p className="admin-muted">
                    Review paid creative, publish approved
                    campaigns, record Telegram publication,
                    and end campaigns early when necessary.
                  </p>
                </div>
              </div>

              <div className="admin-card-grid">
                {pendingAds.map((ad) => {
                  const adPaid = (
                    ad.payments || []
                  ).some(
                    (payment) =>
                      payment.status === 'PAID'
                  );

                  const impressions = (
                    ad.events || []
                  ).filter(
                    (event) =>
                      event.eventType ===
                      'IMPRESSION'
                  ).length;

                  const clicks = (
                    ad.events || []
                  ).filter(
                    (event) =>
                      event.eventType === 'CLICK'
                  ).length;

                  const ctr = impressions
                    ? (
                        (clicks / impressions) *
                        100
                      ).toFixed(2)
                    : '0.00';

                  return (
                    <div
                      className="admin-card"
                      key={ad.id}
                    >
                      {ad.creativeImageUrl && (
                        <img
                          src={ad.creativeImageUrl}
                          alt={
                            ad.headline ||
                            'Campaign creative'
                          }
                          loading="lazy"
                          decoding="async"
                          className="admin-card-media"
                        />
                      )}

                      <div className="admin-card-top">
                        <h3>
                          {ad.type.replace(
                            /_/g,
                            ' '
                          )}
                        </h3>

                        <StatusBadge
                          status={ad.status}
                        />
                      </div>

                      {ad.type ===
                        'TELEGRAM_PROMOTION' &&
                        ad.telegramImageUrls
                          ?.length > 0 && (
                          <div
                            style={{
                              marginTop: 12,
                            }}
                          >
                            <ImageCarousel
                              images={
                                ad.telegramImageUrls
                              }
                              alt={
                                ad.headline ||
                                'Carousel photo'
                              }
                              openLinks
                              className="img-carousel--compact"
                            />
                          </div>
                        )}

                      {ad.type ===
                        'TELEGRAM_PROMOTION' &&
                        ad.telegramTemplate && (
                          <p>
                            <strong>
                              Template:
                            </strong>{' '}
                            {ad.telegramTemplate.replace(
                              /_/g,
                              ' '
                            )}
                            {ad.telegramImageCount >
                              0 &&
                              ` · ${ad.telegramImageCount} photos`}
                          </p>
                        )}

                      {ad.headline && (
                        <p>
                          <strong>
                            {ad.headline}
                          </strong>
                        </p>
                      )}

                      <p>
                        <strong>Ref:</strong>{' '}
                        {ad.campaignReference ||
                          ad.id.slice(0, 8)}
                        {' · '}
                        <strong>
                          Advertiser:
                        </strong>{' '}
                        {ad.advertiser?.name ||
                          'Unknown'}{' '}
                        (
                        {ad.advertiser?.email ||
                          '—'}
                        )
                      </p>

                      <p>
                        {ad.listing ? (
                          <>
                            Featuring{' '}
                            <strong>
                              {ad.listing.title ||
                                ad.listing.cropType}
                            </strong>
                            {' · '}
                          </>
                        ) : (
                          'Platform-wide · '
                        )}

                        {new Date(
                          ad.startDate
                        ).toLocaleDateString()}{' '}
                        —{' '}
                        {new Date(
                          ad.endDate
                        ).toLocaleDateString()}
                      </p>

                      <p>
                        <strong>
                          Quoted:
                        </strong>{' '}
                        {Number(
                          ad.priceQuoted || 0
                        ).toLocaleString()}{' '}
                        {ad.currency || 'ETB'}
                        {' · '}
                        <strong>
                          Paid:
                        </strong>{' '}
                        {adPaid
                          ? Number(
                              ad.amountPaid || 0
                            ).toLocaleString()
                          : '0'}{' '}
                        {ad.currency || 'ETB'}
                        {' · '}
                        <strong>
                          CTR:
                        </strong>{' '}
                        {ctr}%
                      </p>

                      {ad.destinationUrl && (
                        <p className="admin-ad-destination">
                          <strong>
                            Destination:
                          </strong>{' '}
                          {ad.destinationUrl}
                        </p>
                      )}

                      {!adPaid && (
                        <div className="admin-warning-note">
                          Waiting for payment before this
                          campaign can be approved.
                        </div>
                      )}

                      <div className="admin-card-actions">
                        <button
                          type="button"
                          className="admin-mini-btn primary"
                          disabled={
                            actionLoading ===
                              `ad-${ad.id}` ||
                            !adPaid
                          }
                          title={
                            !adPaid
                              ? 'Waiting for payment'
                              : undefined
                          }
                          onClick={() =>
                            setAdStatus(
                              ad.id,
                              'APPROVED'
                            )
                          }
                        >
                          {actionLoading ===
                          `ad-${ad.id}`
                            ? 'Working…'
                            : 'Approve'}
                        </button>

                        <button
                          type="button"
                          className="admin-mini-btn danger"
                          disabled={
                            actionLoading ===
                            `ad-${ad.id}`
                          }
                          onClick={() =>
                            setAdStatus(
                              ad.id,
                              'REJECTED'
                            )
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  );
                })}

                {pendingAds.length === 0 && (
                  <div
                    style={{
                      gridColumn: '1 / -1',
                    }}
                  >
                    <EmptyState>
                      No campaigns waiting on content
                      review.
                    </EmptyState>
                  </div>
                )}
              </div>

              <div
                className="admin-panel"
                style={{ marginTop: 20 }}
              >
                <div className="admin-panel-header">
                  <div>
                    <div className="admin-kicker">
                      CAMPAIGN LEDGER
                    </div>

                    <h2 className="admin-panel-title">
                      Advertising history
                    </h2>

                    <p className="admin-panel-description">
                      Financial, scheduling and engagement
                      visibility for reviewed campaigns.
                    </p>
                  </div>
                </div>

                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Advertiser</th>
                        <th>Dates</th>
                        <th>Financials</th>
                        <th>Analytics</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>

                    <tbody>
                      {reviewedAds
                        .slice(0, 30)
                        .map((ad) => {
                          const impressions = (
                            ad.events || []
                          ).filter(
                            (event) =>
                              event.eventType ===
                              'IMPRESSION'
                          ).length;

                          const clicks = (
                            ad.events || []
                          ).filter(
                            (event) =>
                              event.eventType ===
                              'CLICK'
                          ).length;

                          const ctr = impressions
                            ? (
                                (clicks /
                                  impressions) *
                                100
                              ).toFixed(2)
                            : '0.00';

                          return (
                            <tr key={ad.id}>
                              <td data-label="Campaign">
                                <strong>
                                  {ad.campaignReference ||
                                    ad.type.replace(
                                      /_/g,
                                      ' '
                                    )}
                                </strong>

                                <div className="admin-user-meta">
                                  {ad.type.replace(
                                    /_/g,
                                    ' '
                                  )}
                                </div>

                                {ad.type ===
                                  'TELEGRAM_PROMOTION' &&
                                  ad.telegramImageUrls
                                    ?.length > 0 && (
                                    <details className="admin-details">
                                      <summary>
                                        🎠{' '}
                                        {
                                          ad
                                            .telegramImageUrls
                                            .length
                                        }{' '}
                                        carousel photos
                                      </summary>

                                      <div
                                        style={{
                                          marginTop: 8,
                                        }}
                                      >
                                        <ImageCarousel
                                          images={
                                            ad.telegramImageUrls
                                          }
                                          alt={
                                            ad.headline ||
                                            'Carousel photo'
                                          }
                                          openLinks
                                          className="img-carousel--compact"
                                        />
                                      </div>
                                    </details>
                                  )}
                              </td>

                              <td data-label="Advertiser">
                                {ad.advertiser?.name ||
                                  '—'}
                              </td>

                              <td data-label="Dates">
                                {new Date(
                                  ad.startDate
                                ).toLocaleDateString()}{' '}
                                —{' '}
                                {new Date(
                                  ad.endDate
                                ).toLocaleDateString()}
                              </td>

                              <td data-label="Financials">
                                {Number(
                                  ad.priceQuoted || 0
                                ).toLocaleString()}{' '}
                                {ad.currency ||
                                  'ETB'}{' '}
                                quoted
                                <br />
                                {Number(
                                  ad.amountPaid || 0
                                ).toLocaleString()}{' '}
                                paid
                              </td>

                              <td data-label="Analytics">
                                {impressions} imp ·{' '}
                                {clicks} clicks ·{' '}
                                {ctr}% CTR
                              </td>

                              <td data-label="Status">
                                <StatusBadge
                                  status={ad.status}
                                />
                              </td>

                              <td data-label="Actions">
                                <div className="admin-action-row">
                                  {[
                                    'PUBLISHED',
                                    'ACTIVE',
                                  ].includes(
                                    ad.status
                                  ) && (
                                    <button
                                      type="button"
                                      className="admin-mini-btn"
                                      disabled={
                                        actionLoading ===
                                        `ad-${ad.id}`
                                      }
                                      onClick={() =>
                                        setAdStatus(
                                          ad.id,
                                          'EXPIRED'
                                        )
                                      }
                                    >
                                      {actionLoading ===
                                      `ad-${ad.id}`
                                        ? 'Working…'
                                        : 'End early'}
                                    </button>
                                  )}

                                  {[
                                    'PAID_PENDING_REVIEW',
                                    'APPROVED',
                                    'SCHEDULED',
                                  ].includes(
                                    ad.status
                                  ) && (
                                    <button
                                      type="button"
                                      className="admin-mini-btn danger"
                                      disabled={
                                        actionLoading ===
                                        `ad-${ad.id}`
                                      }
                                      onClick={() =>
                                        cancelAdCampaign(
                                          ad.id
                                        )
                                      }
                                    >
                                      {actionLoading ===
                                      `ad-${ad.id}`
                                        ? 'Working…'
                                        : 'Cancel & refund'}
                                    </button>
                                  )}

                                  {ad.type ===
                                    'TELEGRAM_PROMOTION' &&
                                    [
                                      'APPROVED',
                                      'SCHEDULED',
                                    ].includes(
                                      ad.status
                                    ) && (
                                      <button
                                        type="button"
                                        className="admin-mini-btn primary"
                                        disabled={
                                          actionLoading ===
                                          `ad-${ad.id}`
                                        }
                                        onClick={() =>
                                          markTelegramPublished(
                                            ad.id
                                          )
                                        }
                                      >
                                        Mark Telegram
                                        published
                                      </button>
                                    )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}

                      {reviewedAds.length === 0 && (
                        <tr>
                          <td
                            colSpan="7"
                            data-label="Campaigns"
                          >
                            <EmptyState>
                              No reviewed campaigns
                              yet.
                            </EmptyState>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {tab === 'orders' && (
            <section className="admin-section">
              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">
                    ORDERS
                  </div>

                  <h2>All orders</h2>

                  <p className="admin-muted">
                    Cancelling here is an admin override
                    for stalled orders. It is blocked once
                    a transport job has started pickup,
                    since goods already in motion need a
                    dispute instead.
                  </p>
                </div>
              </div>

              <div className="admin-panel">
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Listing</th>
                        <th>Buyer</th>
                        <th>Seller</th>
                        <th>Value</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>

                    <tbody>
                      {orders.map((order) => {
                        const transportInMotion =
                          Boolean(
                            order.transportJob &&
                              [
                                'PICKUP',
                                'IN_TRANSIT',
                                'DELIVERED',
                              ].includes(
                                order.transportJob
                                  .status
                              )
                          );

                        const cancellable =
                          ![
                            'COMPLETED',
                            'CANCELLED',
                          ].includes(
                            order.status
                          ) &&
                          !transportInMotion;

                        return (
                          <tr key={order.id}>
                            <td data-label="Order">
                              <code className="admin-code">
                                {order.id.slice(0, 8)}
                              </code>
                            </td>

                            <td data-label="Listing">
                              {order.listing?.title ||
                                order.listing
                                  ?.cropType ||
                                '—'}
                            </td>

                            <td data-label="Buyer">
                              {order.buyer?.name ||
                                '—'}
                            </td>

                            <td data-label="Seller">
                              {order.seller?.name ||
                                '—'}
                            </td>

                            <td data-label="Value">
                              <strong>
                                {Number(
                                  order.finalPrice
                                ).toLocaleString()}{' '}
                                ETB
                              </strong>
                            </td>

                            <td data-label="Status">
                              <StatusBadge
                                status={order.status}
                              />
                            </td>

                            <td data-label="Actions">
                              {cancellable ? (
                                <button
                                  type="button"
                                  className="admin-mini-btn"
                                  disabled={
                                    actionLoading ===
                                    `order-${order.id}`
                                  }
                                  onClick={() =>
                                    cancelOrder(
                                      order
                                    )
                                  }
                                >
                                  {actionLoading ===
                                  `order-${order.id}`
                                    ? 'Cancelling…'
                                    : 'Cancel order'}
                                </button>
                              ) : (
                                <span className="admin-muted">
                                  {transportInMotion
                                    ? 'Transport in motion'
                                    : 'Not cancellable'}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {orders.length === 0 && (
                        <tr>
                          <td
                            colSpan="7"
                            data-label="Orders"
                          >
                            <EmptyState>
                              No orders yet.
                            </EmptyState>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {tab === 'operations' && (
            <section className="admin-section">
              <div className="admin-panel">
                <div className="admin-panel-header">
                  <div>
                    <div className="admin-kicker">
                      OPERATIONS
                    </div>

                    <h2 className="admin-panel-title">
                      Operations & audit
                    </h2>

                    <p className="admin-panel-description">
                      Monitor live workflow queues from
                      durable OrderEvent records and review
                      the internal audit trail.
                    </p>
                  </div>

                  <button
                    type="button"
                    className="admin-btn"
                    onClick={loadAll}
                    disabled={loading}
                  >
                    {loading
                      ? 'Refreshing…'
                      : 'Refresh'}
                  </button>
                </div>

                <div className="admin-stat-grid">
                  {[
                    [
                      'Pending payments',
                      operations?.queues
                        ?.pendingPayments || 0,
                    ],
                    [
                      'Reconciliation queue',
                      operations?.queues
                        ?.reconciliationPayments ||
                        0,
                    ],
                    [
                      'Open disputes',
                      operations?.queues
                        ?.openDisputes || 0,
                    ],
                    [
                      'Active orders',
                      operations?.activeOrders ||
                        0,
                    ],
                    [
                      'Active transport',
                      operations?.activeTransportJobs ||
                        0,
                    ],
                  ].map(([label, value]) => (
                    <div
                      className="admin-stat"
                      key={label}
                    >
                      <span className="admin-stat-label">
                        {label}
                      </span>
                      <b className="admin-stat-value">
                        {value}
                      </b>
                    </div>
                  ))}
                </div>
              </div>

              <div className="admin-panel">
                <div className="admin-panel-header">
                  <div>
                    <div className="admin-kicker">
                      WORKFLOW EVENTS
                    </div>

                    <h2 className="admin-panel-title">
                      Recent workflow events
                    </h2>

                    <p className="admin-panel-description">
                      Customer-facing order lifecycle
                      events. This is read-only operational
                      visibility.
                    </p>
                  </div>
                </div>

                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Event</th>
                        <th>Order</th>
                        <th>Transition</th>
                        <th>Actor</th>
                      </tr>
                    </thead>

                    <tbody>
                      {orderEvents.length === 0 ? (
                        <tr>
                          <td
                            colSpan="5"
                            data-label="Events"
                          >
                            <EmptyState>
                              No workflow events
                              recorded yet.
                            </EmptyState>
                          </td>
                        </tr>
                      ) : (
                        orderEvents.map((event) => (
                          <tr key={event.id}>
                            <td data-label="Time">
                              {new Date(
                                event.createdAt
                              ).toLocaleString()}
                            </td>

                            <td data-label="Event">
                              <span className="admin-chip">
                                {event.type}
                              </span>
                            </td>

                            <td data-label="Order">
                              <code className="admin-code">
                                {event.orderId.slice(
                                  0,
                                  10
                                )}
                              </code>
                            </td>

                            <td data-label="Transition">
                              {event.fromStatus ||
                                '—'}{' '}
                              →{' '}
                              {event.toStatus ||
                                '—'}
                            </td>

                            <td data-label="Actor">
                              {event.actor?.name ||
                                event.actor?.email ||
                                'System'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="admin-panel">
                <div className="admin-panel-header">
                  <div>
                    <div className="admin-kicker">
                      SECURITY TRAIL
                    </div>

                    <h2 className="admin-panel-title">
                      Recent audit events
                    </h2>

                    <p className="admin-panel-description">
                      Internal administrative/security
                      trail. Secrets and tokens are not
                      exposed here.
                    </p>
                  </div>
                </div>

                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Action</th>
                        <th>Resource</th>
                        <th>Actor</th>
                      </tr>
                    </thead>

                    <tbody>
                      {auditEvents.length === 0 ? (
                        <tr>
                          <td
                            colSpan="4"
                            data-label="Events"
                          >
                            <EmptyState>
                              No audit events
                              recorded yet.
                            </EmptyState>
                          </td>
                        </tr>
                      ) : (
                        auditEvents.map((event) => (
                          <tr key={event.id}>
                            <td data-label="Time">
                              {new Date(
                                event.createdAt
                              ).toLocaleString()}
                            </td>

                            <td data-label="Action">
                              <span className="admin-chip">
                                {event.action}
                              </span>
                            </td>

                            <td data-label="Resource">
                              {event.resourceType}
                              {event.resourceId
                                ? ` · ${event.resourceId.slice(
                                    0,
                                    10
                                  )}`
                                : ''}
                            </td>

                            <td data-label="Actor">
                              {event.actor?.name ||
                                event.actor?.email ||
                                'System'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {tab === 'payments' && (
            <section className="admin-section">
              <div className="admin-kicker">
                FINANCE
              </div>

              <div
                className="admin-stat-grid admin-financial-grid"
                style={{ marginTop: 8 }}
              >
                <div className="admin-stat">
                  <span className="admin-stat-label">
                    Total confirmed volume
                  </span>

                  <b className="admin-stat-value">
                    {Number(
                      commissionSummary?.totalVolume ||
                        0
                    ).toLocaleString()}{' '}
                    ETB
                  </b>
                </div>

                <div className="admin-stat">
                  <span className="admin-stat-label">
                    Platform commission earned
                  </span>

                  <b className="admin-stat-value">
                    {Number(
                      commissionSummary?.totalCommission ||
                        0
                    ).toLocaleString()}{' '}
                    ETB
                  </b>
                </div>

                {Object.entries(
                  commissionSummary?.byType || {}
                ).map(([type, value]) => (
                  <div
                    className="admin-stat"
                    key={type}
                  >
                    <span className="admin-stat-label">
                      {type} · {value.count} payment
                      {value.count === 1
                        ? ''
                        : 's'}
                    </span>

                    <b className="admin-stat-value">
                      {Number(
                        value.commission
                      ).toLocaleString()}{' '}
                      ETB
                    </b>
                  </div>
                ))}
              </div>

              <div className="admin-section-heading">
                <div>
                  <div className="admin-kicker">
                    RECONCILIATION
                  </div>

                  <h2>
                    Payment reconciliation
                  </h2>

                  <p className="admin-muted">
                    Payment records waiting to be
                    confirmed, plus records flagged for
                    reconciliation after a mismatch or
                    failed automatic verification.
                  </p>
                </div>
              </div>

              <div className="admin-card-grid">
                {payments.map((payment) => (
                  <div
                    className="admin-card"
                    key={payment.id}
                  >
                    <div className="admin-card-top">
                      <h3>
                        {Number(
                          payment.amount
                        ).toLocaleString()}{' '}
                        ETB
                      </h3>

                      <StatusBadge
                        status={payment.status}
                      />
                    </div>

                    <p>
                      <strong>
                        {payment.type}
                      </strong>{' '}
                      via{' '}
                      <strong>
                        {payment.method}
                      </strong>
                    </p>

                    <p>
                      {payment.createdBy?.name ||
                        'Unknown user'}{' '}
                      (
                      {payment.createdBy?.email ||
                        '—'}
                      )
                      {payment.reference && (
                        <>
                          {' · '}
                          Ref:{' '}
                          {payment.reference}
                        </>
                      )}
                    </p>

                    <p>
                      {payment.order &&
                        `Order ${payment.order.id.slice(
                          0,
                          8
                        )}`}
                      {payment.digitalProduct &&
                        `Digital product: ${payment.digitalProduct.title}`}
                      {payment.advertisement &&
                        `Ad campaign: ${payment.advertisement.type.replace(
                          /_/g,
                          ' '
                        )}`}
                      {' · '}
                      {new Date(
                        payment.createdAt
                      ).toLocaleString()}
                    </p>

                    <div className="admin-card-actions">
                      {payment.provider ? (
                        <button
                          type="button"
                          className="admin-mini-btn primary"
                          disabled={
                            actionLoading ===
                            `payment-${payment.id}`
                          }
                          onClick={() =>
                            checkGatewayPayment(
                              payment.id,
                              payment.provider
                            )
                          }
                        >
                          {actionLoading ===
                          `payment-${payment.id}`
                            ? 'Checking…'
                            : `Check with ${payment.provider}`}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="admin-mini-btn primary"
                          disabled={
                            actionLoading ===
                            `payment-${payment.id}`
                          }
                          onClick={() =>
                            confirmPayment(
                              payment.id
                            )
                          }
                        >
                          {actionLoading ===
                          `payment-${payment.id}`
                            ? 'Working…'
                            : 'Confirm payment received'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                {payments.length === 0 && (
                  <div
                    style={{
                      gridColumn: '1 / -1',
                    }}
                  >
                    <EmptyState>
                      No payments awaiting
                      reconciliation right now.
                    </EmptyState>
                  </div>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
