import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdvertisementBanner from '../components/AdvertisementBanner.jsx';
import api from '../api/client';

const pillars = [
  [
    '01',
    'Agricultural marketplace',
    'Connect farmers, agricultural producers, investors and buyers for farm-produced goods, including bulk and time-sensitive harvests.',
  ],
  [
    '02',
    'Physical products',
    'Buy and sell general physical products through independent sellers and buyers without MarketBridge owning the merchandise.',
  ],
  [
    '03',
    'Digital marketplace',
    'Discover and sell eBooks, courses, software, documents, templates, graphics, photos and other digital products.',
  ],
];

const marketplaceCards = [
  {
    number: '01',
    label: 'AGRICULTURE',
    title: 'Agricultural',
    description:
      'A specialized marketplace for farm-produced goods, bulk lots and time-sensitive harvests.',
    features: [
      'Farmers & producers',
      'Bulk agricultural lots',
      'Offers & negotiation',
      'Inspection & evidence',
      'Transport arrangement',
    ],
    link: '/agricultural',
    button: 'Enter Agricultural Marketplace',
    tone: 'green',
  },
  {
    number: '02',
    label: 'PHYSICAL COMMERCE',
    title: 'Products',
    description:
      'A broader marketplace connecting independent sellers with buyers looking for physical products.',
    features: [
      'Physical products',
      'Independent sellers',
      'Buyer discovery',
      'Orders & records',
      'Delivery options',
    ],
    link: '/products',
    button: 'Browse Physical Products',
    tone: 'gold',
  },
  {
    number: '03',
    label: 'DIGITAL COMMERCE',
    title: 'Digital',
    description:
      'A marketplace for independently supplied digital products and downloadable resources.',
    features: [
      'eBooks',
      'Courses',
      'Software',
      'Documents & templates',
      'Graphics & photos',
    ],
    link: '/digital',
    button: 'Browse Digital Products',
    tone: 'blue',
  },
];

const HOME_PAGE_STYLES = `
  .mb-home {
    --home-green: #167247;
    --home-green-dark: #0d4d31;
    --home-green-soft: #eaf7ef;
    --home-gold: #b87918;
    --home-ink: #13261c;
    --home-muted: #617067;
    --home-line: rgba(21, 67, 45, .12);
    --home-card: rgba(255,255,255,.84);
    --home-shadow: 0 20px 60px rgba(21, 55, 37, .09);
    color: var(--home-ink);
    overflow: hidden;
    background: #fbfcfa;
  }

  .mb-home *,
  .mb-home *::before,
  .mb-home *::after {
    box-sizing: border-box;
  }

  .mb-home .home-container {
    width: min(1220px, calc(100% - 40px));
    margin: 0 auto;
  }

  .mb-home .home-hero {
    position: relative;
    min-height: 680px;
    display: flex;
    align-items: center;
    overflow: hidden;
    background:
      radial-gradient(circle at 86% 18%, rgba(46, 154, 93, .15), transparent 27%),
      radial-gradient(circle at 12% 90%, rgba(184, 121, 24, .08), transparent 25%),
      linear-gradient(135deg, #eef8f0 0%, #f8fbf8 53%, #edf5ef 100%);
    border-bottom: 1px solid var(--home-line);
  }

  .mb-home .home-hero::before {
    content: '';
    position: absolute;
    width: 560px;
    height: 560px;
    right: -250px;
    top: -220px;
    border-radius: 50%;
    border: 1px solid rgba(22,114,71,.10);
    box-shadow:
      0 0 0 55px rgba(22,114,71,.025),
      0 0 0 110px rgba(22,114,71,.018);
  }

  .mb-home .home-hero::after {
    content: '';
    position: absolute;
    width: 360px;
    height: 360px;
    left: -230px;
    bottom: -250px;
    border-radius: 50%;
    background: rgba(184,121,24,.055);
  }

  .mb-home .hero-grid {
    position: relative;
    z-index: 2;
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr);
    grid-template-areas:
      "content visual"
      "carousel visual";
    gap: clamp(40px, 7vw, 90px);
    align-items: center;
    padding: 82px 0;
  }

  .mb-home .hero-content { grid-area: content; }
  .mb-home .hero-grid .trust-carousel { grid-area: carousel; align-self: start; }
  .mb-home .hero-grid .hero-visual { grid-area: visual; }

  .mb-home .hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 20px;
    padding: 7px 11px;
    border: 1px solid rgba(22,114,71,.16);
    border-radius: 999px;
    background: rgba(255,255,255,.62);
    color: var(--home-green-dark);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 1.8px;
  }

  .mb-home .hero-eyebrow::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #35a461;
    box-shadow: 0 0 0 5px rgba(53,164,97,.10);
  }

  .mb-home .hero-title {
    max-width: 800px;
    margin: 0;
    color: #10261a;
    font-size: clamp(42px, 6vw, 76px);
    line-height: .98;
    letter-spacing: -3.5px;
    font-weight: 850;
  }

  .mb-home .hero-title span {
    display: block;
    color: var(--home-green);
  }

  .mb-home .hero-description {
    max-width: 690px;
    margin: 25px 0 0;
    color: #56655c;
    font-size: clamp(16px, 2vw, 19px);
    line-height: 1.7;
  }

  .mb-home .home-btn {
    min-height: 48px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 19px;
    border-radius: 13px;
    text-decoration: none;
    font-size: 13px;
    font-weight: 800;
    transition:
      transform .2s ease,
      box-shadow .2s ease,
      background .2s ease;
  }

  .mb-home .home-btn:hover {
    transform: translateY(-2px);
  }

  .mb-home .home-btn-primary {
    color: #fff;
    background: linear-gradient(135deg, #18794c, #0f603a);
    box-shadow: 0 12px 25px rgba(16,104,61,.20);
  }

  .mb-home .home-btn-primary:hover {
    box-shadow: 0 16px 30px rgba(16,104,61,.27);
  }

  .mb-home .home-btn-light {
    color: #173b2a;
    background: rgba(255,255,255,.78);
    border: 1px solid rgba(22,114,71,.15);
  }

  .mb-home .home-btn-light:hover {
    background: #fff;
  }

  .mb-home .trust-carousel {
    overflow: hidden;
    width: 100%;
    padding: 16px 0;
    margin-top: 10px;
    background: var(--home-green-soft);
    border-top: 1px solid rgba(22,114,71,.10);
    border-bottom: 1px solid rgba(22,114,71,.10);
  }

  .mb-home .trust-carousel-track {
    display: flex;
    width: max-content;
    gap: 40px;
    animation: mb-trust-scroll 16s linear infinite;
  }

  .mb-home .trust-carousel-track span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    color: #607068;
    font-size: 12px;
    font-weight: 600;
  }

  .mb-home .trust-carousel-track b {
    color: var(--home-green);
    font-size: 14px;
  }

  @keyframes mb-trust-scroll {
    from { transform: translateX(0); }
    to { transform: translateX(-50%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .mb-home .trust-carousel-track {
      animation: none;
    }
  }

  /* Live marketplace statistics */

  .mb-home .hero-stat-card {
    position: relative;
    z-index: 5;
    top: auto;
    right: auto;
    width: min(370px, 100%);
    margin: 0 0 18px auto;
    padding: 18px;
    border: 1px solid rgba(255,255,255,.94);
    border-radius: 22px;
    background: rgba(255,255,255,.90);
    box-shadow: 0 24px 55px rgba(25,65,42,.14), inset 0 1px 0 rgba(255,255,255,.95);
    backdrop-filter: blur(18px);
  }

  .mb-home .hero-stat-card::before {
    content: '';
    position: absolute;
    width: 120px;
    height: 120px;
    right: -45px;
    top: -55px;
    border-radius: 50%;
    background: rgba(22,114,71,.06);
    pointer-events: none;
  }

  .mb-home .hero-stat-header {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }

  .mb-home .hero-stat-label {
    color: #183b29;
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 1.5px;
  }

  .mb-home .hero-stat-live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #28734c;
    font-size: 9px;
    font-weight: 800;
    white-space: nowrap;
  }

  .mb-home .hero-stat-live::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #35a461;
    box-shadow: 0 0 0 4px rgba(53,164,97,.10);
  }

  .mb-home .hero-stat-grid {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .mb-home .hero-stat {
    min-width: 0;
    padding: 12px 13px;
    border: 1px solid rgba(21,67,45,.08);
    border-radius: 14px;
    background: rgba(248,251,249,.82);
  }

  .mb-home .hero-stat strong {
    display: block;
    color: #123c29;
    font-size: 21px;
    line-height: 1.05;
    letter-spacing: -.7px;
  }

  .mb-home .hero-stat span {
    display: block;
    margin-top: 5px;
    color: #718078;
    font-size: 9px;
    font-weight: 750;
    line-height: 1.25;
  }

  .mb-home .hero-stat-footer {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 11px;
    color: #7a867f;
    font-size: 8px;
  }

  .mb-home .hero-stat-refresh {
    color: #28734c;
    font-weight: 800;
  }

  .mb-home .hero-stat-loading {
    opacity: .58;
  }

  /* Hero visual */

  .mb-home .hero-visual {
    position: relative;
  }

  .mb-home .platform-card {
    position: relative;
    padding: 25px;
    border: 1px solid rgba(255,255,255,.9);
    border-radius: 26px;
    background:
      linear-gradient(145deg, rgba(255,255,255,.90), rgba(246,250,247,.72));
    box-shadow:
      0 30px 70px rgba(25,65,42,.13),
      inset 0 1px 0 rgba(255,255,255,.9);
    backdrop-filter: blur(18px);
  }

  .mb-home .platform-card::before {
    content: '';
    position: absolute;
    inset: 10px;
    border: 1px solid rgba(22,114,71,.07);
    border-radius: 19px;
    pointer-events: none;
  }

  .mb-home .platform-header {
    position: relative;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .mb-home .platform-label {
    color: #506057;
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 1.7px;
  }

  .mb-home .platform-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #28734c;
    font-size: 10px;
    font-weight: 800;
  }

  .mb-home .platform-status::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #35a461;
    box-shadow: 0 0 0 4px rgba(53,164,97,.10);
  }

  .mb-home .platform-main {
    position: relative;
    padding: 21px;
    border-radius: 18px;
    background: linear-gradient(135deg, #123c29, #176443);
    color: #fff;
    overflow: hidden;
  }

  .mb-home .platform-main::after {
    content: '';
    position: absolute;
    width: 180px;
    height: 180px;
    right: -70px;
    top: -80px;
    border-radius: 50%;
    background: rgba(255,255,255,.07);
  }

  .mb-home .platform-main small {
    position: relative;
    z-index: 1;
    display: block;
    margin-bottom: 7px;
    color: rgba(255,255,255,.64);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 1.4px;
  }

  .mb-home .platform-main strong {
    position: relative;
    z-index: 1;
    display: block;
    font-size: 24px;
    line-height: 1.2;
  }

  .mb-home .platform-main p {
    position: relative;
    z-index: 1;
    margin: 9px 0 0;
    color: rgba(255,255,255,.72);
    font-size: 12px;
    line-height: 1.55;
  }

  .mb-home .platform-flow {
    margin-top: 17px;
  }

  .mb-home .platform-step {
    display: grid;
    grid-template-columns: 30px 1fr auto;
    align-items: center;
    gap: 11px;
    padding: 13px 0;
    border-bottom: 1px solid rgba(24,68,45,.09);
    text-decoration: none;
    color: inherit;
    transition: transform .15s ease, opacity .15s ease;
  }

  .mb-home .platform-step:last-child {
    border-bottom: 0;
  }

  .mb-home .platform-step:hover {
    transform: translateX(2px);
  }

  .mb-home .platform-step:hover .step-arrow {
    color: var(--home-green);
  }

  .mb-home .step-number {
    width: 29px;
    height: 29px;
    display: grid;
    place-items: center;
    border-radius: 9px;
    background: #edf7f0;
    color: var(--home-green);
    font-size: 10px;
    font-weight: 900;
  }

  .mb-home .step-copy strong {
    display: block;
    font-size: 12px;
    color: #20392c;
  }

  .mb-home .step-copy span {
    display: block;
    margin-top: 2px;
    color: #7a867f;
    font-size: 10px;
  }

  .mb-home .step-arrow {
    color: #9aa59e;
    font-size: 13px;
    transition: color .15s ease;
  }

  .mb-home .floating-badge {
    position: absolute;
    right: -25px;
    bottom: -22px;
    padding: 13px 16px;
    border: 1px solid rgba(255,255,255,.95);
    border-radius: 15px;
    background: rgba(255,255,255,.91);
    box-shadow: 0 15px 35px rgba(27,62,42,.13);
    backdrop-filter: blur(14px);
  }

  .mb-home .floating-badge strong {
    display: block;
    color: #183b29;
    font-size: 12px;
  }

  .mb-home .floating-badge span {
    display: block;
    margin-top: 2px;
    color: #78847d;
    font-size: 10px;
  }

  /* Hero join (plain hero elements) */

  .mb-home .hero-join {
    margin-top: 26px;
  }

  .mb-home .hero-join strong {
    display: block;
    color: #173b2a;
    font-size: 17px;
  }

  .mb-home .hero-join > span {
    display: block;
    margin-top: 6px;
    max-width: 46ch;
    color: #56635a;
    font-size: 13px;
    line-height: 1.55;
  }

  .mb-home .account-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 11px;
    margin-top: 16px;
  }

  .mb-home .account-actions .home-btn {
    min-height: 42px;
    padding: 9px 14px;
    font-size: 11px;
  }

  /* General sections */

  .mb-home .home-section {
    padding: clamp(40px, 4.5vw, 60px) 0;
  }

  .mb-home .home-section-alt {
    background:
      linear-gradient(180deg, #f1f7f2 0%, #f8faf8 100%);
    border-top: 1px solid rgba(22,114,71,.06);
    border-bottom: 1px solid rgba(22,114,71,.06);
  }

  .mb-home .section-heading {
    max-width: 780px;
    margin-bottom: 26px;
  }

  .mb-home .section-heading.center {
    margin-left: auto;
    margin-right: auto;
    text-align: center;
  }

  .mb-home .eyebrow {
    display: inline-block;
    margin-bottom: 11px;
    color: var(--home-green);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 1.7px;
  }

  .mb-home .section-heading h2,
  .mb-home .split-content h2 {
    margin: 0;
    color: #142a1e;
    font-size: clamp(29px, 4vw, 46px);
    line-height: 1.08;
    letter-spacing: -1.7px;
  }

  .mb-home .section-heading p {
    margin: 13px 0 0;
    color: #65736b;
    line-height: 1.7;
  }

  /* Marketplace cards */

  .mb-home .marketplace-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
  }

  .mb-home .market-card {
    position: relative;
    min-width: 0;
    padding: 27px;
    overflow: hidden;
    border: 1px solid var(--home-line);
    border-radius: 22px;
    background: rgba(255,255,255,.82);
    box-shadow: 0 12px 35px rgba(26,57,39,.055);
    transition:
      transform .22s ease,
      box-shadow .22s ease,
      border-color .22s ease;
  }

  .mb-home .market-card:hover {
    transform: translateY(-5px);
    border-color: rgba(22,114,71,.20);
    box-shadow: var(--home-shadow);
  }

  .mb-home .market-card::after {
    content: '';
    position: absolute;
    width: 150px;
    height: 150px;
    right: -80px;
    bottom: -80px;
    border-radius: 50%;
    background: rgba(22,114,71,.045);
    pointer-events: none;
  }

  .mb-home .market-card.gold::after {
    background: rgba(184,121,24,.055);
  }

  .mb-home .market-card.blue::after {
    background: rgba(52,108,164,.05);
  }

  .mb-home .market-number {
    display: inline-grid;
    place-items: center;
    width: 38px;
    height: 38px;
    margin-bottom: 18px;
    border-radius: 11px;
    background: #eaf7ef;
    color: var(--home-green);
    font-size: 11px;
    font-weight: 900;
  }

  .mb-home .market-card.gold .market-number {
    background: #fbf2e4;
    color: #a46c16;
  }

  .mb-home .market-card.blue .market-number {
    background: #edf3f9;
    color: #356da2;
  }

  .mb-home .market-label {
    display: block;
    margin-bottom: 7px;
    color: #7a877f;
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 1.5px;
  }

  .mb-home .market-card h3 {
    margin: 0;
    color: #183324;
    font-size: 25px;
    letter-spacing: -.7px;
  }

  .mb-home .market-card p {
    min-height: 78px;
    margin: 11px 0 17px;
    color: #68766e;
    font-size: 13px;
    line-height: 1.65;
  }

  .mb-home .market-list {
    display: grid;
    gap: 9px;
    margin: 0 0 22px;
    padding: 0;
    list-style: none;
  }

  .mb-home .market-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #4e5f55;
    font-size: 11px;
    font-weight: 650;
  }

  .mb-home .market-list li::before {
    content: '✓';
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    border-radius: 50%;
    background: #edf7f0;
    color: var(--home-green);
    font-size: 9px;
    font-weight: 900;
  }

  .mb-home .market-link {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--home-green);
    text-decoration: none;
    font-size: 12px;
    font-weight: 850;
  }

  .mb-home .market-link:hover {
    text-decoration: underline;
  }

  /* Split sections */

  .mb-home .split-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(330px, .78fr);
    gap: clamp(35px, 8vw, 100px);
    align-items: center;
  }

  .mb-home .split-grid.reverse {
    grid-template-columns: minmax(330px, .78fr) minmax(0, 1fr);
  }

  .mb-home .split-content p {
    max-width: 690px;
    margin: 16px 0 0;
    color: #637169;
    font-size: 14px;
    line-height: 1.75;
  }

  .mb-home .split-link {
    display: inline-flex;
    margin-top: 23px;
    color: var(--home-green);
    text-decoration: none;
    font-size: 12px;
    font-weight: 850;
  }

  .mb-home .split-link:hover {
    text-decoration: underline;
  }

  .mb-home .info-panel {
    padding: 24px;
    border: 1px solid var(--home-line);
    border-radius: 22px;
    background: rgba(255,255,255,.82);
    box-shadow: var(--home-shadow);
  }

  .mb-home .info-row {
    display: grid;
    grid-template-columns: 115px 1fr;
    gap: 16px;
    padding: 15px 0;
    border-bottom: 1px solid rgba(21,67,45,.08);
  }

  .mb-home .info-row:first-child {
    padding-top: 2px;
  }

  .mb-home .info-row:last-child {
    padding-bottom: 2px;
    border-bottom: 0;
  }

  .mb-home .info-row strong {
    color: #1b3b2b;
    font-size: 12px;
  }

  .mb-home .info-row span {
    color: #6d7972;
    font-size: 11px;
    line-height: 1.5;
  }

  .mb-home .info-panel.digital {
    background: linear-gradient(145deg, rgba(244,248,253,.92), rgba(255,255,255,.86));
  }

  /* Process */

  .mb-home .process-shell {
    padding: 28px;
    border: 1px solid var(--home-line);
    border-radius: 25px;
    background: rgba(255,255,255,.82);
    box-shadow: var(--home-shadow);
  }

  .mb-home .process-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
  }

  .mb-home .process-item {
    position: relative;
    padding: 20px;
    min-height: 115px;
    border-right: 1px solid rgba(21,67,45,.09);
  }

  .mb-home .process-item:nth-child(4n) {
    border-right: 0;
  }

  .mb-home .process-item:nth-child(n+5) {
    border-top: 1px solid rgba(21,67,45,.09);
  }

  .mb-home .process-number {
    display: block;
    margin-bottom: 12px;
    color: var(--home-green);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 1px;
  }

  .mb-home .process-item strong {
    display: block;
    color: #1b3829;
    font-size: 13px;
  }

  .mb-home .process-item span {
    display: block;
    margin-top: 5px;
    color: #758079;
    font-size: 10px;
    line-height: 1.45;
  }

  /* Final CTA */

  .mb-home .final-cta {
    position: relative;
    overflow: hidden;
    padding: clamp(50px, 7vw, 75px);
    border-radius: 28px;
    background:
      radial-gradient(circle at 88% 15%, rgba(255,255,255,.10), transparent 25%),
      linear-gradient(135deg, #103c28, #176a43);
    color: #fff;
    box-shadow: 0 25px 65px rgba(15,75,44,.18);
  }

  .mb-home .final-cta::after {
    content: '';
    position: absolute;
    width: 300px;
    height: 300px;
    right: -150px;
    bottom: -190px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,.12);
    box-shadow: 0 0 0 45px rgba(255,255,255,.025);
  }

  .mb-home .final-cta-content {
    position: relative;
    z-index: 1;
    max-width: 800px;
  }

  .mb-home .final-cta .eyebrow {
    color: rgba(255,255,255,.65);
  }

  .mb-home .final-cta h2 {
    margin: 0;
    color: #fff;
    font-size: clamp(30px, 4vw, 48px);
    line-height: 1.05;
    letter-spacing: -1.8px;
  }

  .mb-home .final-cta p {
    max-width: 650px;
    margin: 14px 0 0;
    color: rgba(255,255,255,.72);
    line-height: 1.7;
  }

  .mb-home .final-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    margin-top: 26px;
  }

  .mb-home .final-actions .home-btn-primary {
    color: #17462f;
    background: #fff;
    box-shadow: none;
  }

  .mb-home .final-actions .home-btn-light {
    color: #fff;
    border-color: rgba(255,255,255,.18);
    background: rgba(255,255,255,.09);
  }

  /* Responsive */

  @media (max-width: 820px) {
    .mb-home .hero-grid {
      grid-template-columns: 1fr;
      grid-template-areas:
        "content"
        "carousel"
        "visual";
      padding: 70px 0 85px;
    }

    .mb-home .hero-visual {
      margin-top: clamp(-20px, -2vw, -8px);
    }

    .mb-home .hero-stat-card {
      width: min(560px, 100%);
      margin: 0 auto 18px;
    }

    .mb-home .hero-title {
      max-width: 800px;
    }

    .mb-home .hero-visual {
      max-width: 680px;
    }

    .mb-home .marketplace-grid {
      grid-template-columns: 1fr 1fr;
    }

    .mb-home .market-card:last-child {
      grid-column: 1 / -1;
      max-width: calc(50% - 9px);
    }

    .mb-home .split-grid,
    .mb-home .split-grid.reverse {
      grid-template-columns: 1fr;
      gap: 35px;
    }

    .mb-home .split-grid.reverse .info-panel {
      order: 2;
    }

    .mb-home .process-grid {
      grid-template-columns: 1fr 1fr;
    }

    .mb-home .process-item:nth-child(4n) {
      border-right: 1px solid rgba(21,67,45,.09);
    }

    .mb-home .process-item:nth-child(2n) {
      border-right: 0;
    }

    .mb-home .process-item:nth-child(n+3) {
      border-top: 1px solid rgba(21,67,45,.09);
    }
  }

  @media (max-width: 720px) {
    .mb-home .home-container {
      width: min(100% - 28px, 1220px);
    }

    .mb-home .home-hero {
      min-height: auto;
    }

    .mb-home .hero-grid {
      padding: 52px 0 72px;
      gap: 45px;
    }

    .mb-home .hero-visual {
      margin-top: -45px;
    }

    .mb-home .hero-stat-card {
      display: none;
    }

    .mb-home .hero-title {
      font-size: clamp(39px, 11vw, 58px);
      letter-spacing: -2.5px;
    }

    .mb-home .hero-description {
      font-size: 16px;
    }

    .mb-home .floating-badge {
      right: 8px;
    }

    .mb-home .marketplace-grid {
      grid-template-columns: 1fr;
    }

    .mb-home .market-card:last-child {
      grid-column: auto;
      max-width: none;
    }

    .mb-home .market-card p {
      min-height: 0;
    }

    .mb-home .home-section {
      padding: 36px 0;
    }

    .mb-home .process-grid {
      grid-template-columns: 1fr;
    }

    .mb-home .process-item,
    .mb-home .process-item:nth-child(4n),
    .mb-home .process-item:nth-child(2n) {
      border-right: 0;
      border-bottom: 1px solid rgba(21,67,45,.09);
    }

    .mb-home .process-item:nth-child(n+3) {
      border-top: 0;
    }

    .mb-home .process-item:last-child {
      border-bottom: 0;
    }

    .mb-home .final-cta {
      padding: 38px 24px;
      border-radius: 22px;
    }
  }

  @media (max-width: 520px) {
    .mb-home .hero-visual {
      width: 100%;
    }

    .mb-home .platform-card {
      padding: 18px;
      border-radius: 21px;
    }

    .mb-home .platform-main {
      padding: 18px;
    }

    .mb-home .floating-badge {
      position: relative;
      right: auto;
      bottom: auto;
      display: inline-block;
      margin-top: 12px;
    }

    .mb-home .account-actions {
      flex-direction: column;
    }

    .mb-home .account-actions .home-btn {
      width: 100%;
    }

    .mb-home .info-row {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .mb-home .final-actions {
      flex-direction: column;
    }

    .mb-home .final-actions .home-btn {
      width: 100%;
    }
  }
`;

function formatStat(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function HeroMarketplaceStats({ stats, loading }) {
  const items = [
    ['activeListings', 'Active listings'],
    ['activeUsers', 'Marketplace users'],
    ['completedOrders', 'Completed orders'],
    ['agriculturalLots', 'Agricultural lots'],
  ];

  return (
    <aside className={`hero-stat-card${loading ? ' hero-stat-loading' : ''}`} aria-label="Live MarketBridge marketplace statistics">
      <div className="hero-stat-header">
        <span className="hero-stat-label">MARKETPLACE LIVE</span>
        <span className="hero-stat-live">Live statistics</span>
      </div>

      <div className="hero-stat-grid">
        {items.map(([key, label]) => (
          <div className="hero-stat" key={key}>
            <strong>{formatStat(stats?.[key])}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="hero-stat-footer">
        <span>{stats?.updatedAt ? `Updated ${new Date(stats.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Connecting to marketplace data'}</span>
        <span className="hero-stat-refresh">Auto-refresh · 60s</span>
      </div>
    </aside>
  );
}

function PlatformStep({ number, title, description, link }) {
  return (
    <Link className="platform-step" to={link}>
      <div className="step-number">{number}</div>
      <div className="step-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <span className="step-arrow">→</span>
    </Link>
  );
}

export default function Home() {
  const [marketStats, setMarketStats] = useState(null);
  const [marketStatsLoading, setMarketStatsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadStats = async () => {
      try {
        const response = await api.get('/public/stats', { timeout: 8000 });
        if (!cancelled) setMarketStats(response.data?.stats || null);
      } catch {
        if (!cancelled) setMarketStats(null);
      } finally {
        if (!cancelled) setMarketStatsLoading(false);
      }
    };

    loadStats();
    const interval = window.setInterval(loadStats, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <main className="mb-home">
      <style>{HOME_PAGE_STYLES}</style>

      {/* HERO */}
      <section className="home-hero">
        <div className="home-container hero-grid">
          <div className="hero-content">
            <div className="hero-eyebrow">MARKETBRIDGE PLATFORM</div>

            <h1 className="hero-title">
              One marketplace.
              <span>Three ways to trade.</span>
            </h1>

            <p className="hero-description">
              MarketBridge connects farmers, producers, sellers, buyers,
              investors and independent service providers through one
              marketplace platform for agricultural, physical and digital
              commerce.
            </p>

            <div className="hero-join">
              <strong>New to MarketBridge?</strong>
              <span>
                Create an account to buy, sell, negotiate and participate
                across the marketplace.
              </span>

              <div className="account-actions">
                <Link className="home-btn home-btn-primary" to="/register">
                  Join MarketBridge
                </Link>

                <Link className="home-btn home-btn-light" to="/login">
                  Welcome back · Sign in
                </Link>
              </div>
            </div>
          </div>

          {/* TRUST CAROUSEL */}
          <div className="trust-carousel">
            <div className="trust-carousel-track">
              <span><b>✓</b> Independent sellers</span>
              <span><b>✓</b> Buyer & seller accounts</span>
              <span><b>✓</b> Offers & negotiation</span>
              <span><b>✓</b> Marketplace records</span>
              <span><b>✓</b> Independent sellers</span>
              <span><b>✓</b> Buyer & seller accounts</span>
              <span><b>✓</b> Offers & negotiation</span>
              <span><b>✓</b> Marketplace records</span>
            </div>
          </div>

          <div className="hero-visual">
            <HeroMarketplaceStats stats={marketStats} loading={marketStatsLoading} />

            <div className="platform-card">
              <div className="platform-header">
                <span className="platform-label">MARKETBRIDGE STRUCTURE</span>
                <span className="platform-status">Connected</span>
              </div>

              <div className="platform-main">
                <small>ONE PLATFORM</small>
                <strong>A marketplace built around people.</strong>
                <p>
                  Independent producers and sellers keep ownership of their
                  goods while MarketBridge provides marketplace infrastructure.
                </p>
              </div>

              <div className="platform-flow">
                <PlatformStep
                  number="01"
                  title="Agricultural"
                  description="Farm produce, offers, inspection & transport"
                  link="/agricultural"
                />
                <PlatformStep
                  number="02"
                  title="Products"
                  description="Independent physical product sellers"
                  link="/products"
                />
                <PlatformStep
                  number="03"
                  title="Digital"
                  description="eBooks, courses, software & creative products"
                  link="/digital"
                />
              </div>
            </div>

            <div className="floating-badge">
              <strong>Discover → Negotiate → Buy</strong>
              <span>Designed for marketplace transactions</span>
            </div>
          </div>
        </div>
      </section>

      <AdvertisementBanner />

      {/* MARKETPLACES */}
      <section className="home-section" id="marketplaces">
        <div className="home-container">
          <div className="section-heading">
            <span className="eyebrow">MARKETPLACE NETWORK</span>
            <h2>Three marketplaces. One MarketBridge platform.</h2>
            <p>
              Choose the marketplace that matches what you want to buy or sell,
              while keeping the same underlying marketplace infrastructure.
            </p>
          </div>

          <div className="marketplace-grid">
            {marketplaceCards.map((marketplace) => (
              <article
                className={`market-card ${marketplace.tone}`}
                key={marketplace.number}
              >
                <span className="market-number">{marketplace.number}</span>

                <span className="market-label">{marketplace.label}</span>

                <h3>{marketplace.title}</h3>

                <p>{marketplace.description}</p>

                <ul className="market-list">
                  {marketplace.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>

                <Link className="market-link" to={marketplace.link}>
                  {marketplace.button} <span>→</span>
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="home-section">
        <div className="home-container">
          <div className="section-heading">
            <span className="eyebrow">HOW IT WORKS</span>
            <h2>MarketBridge facilitates the marketplace.</h2>
            <p>
              The platform brings the participants, communication, records and
              transaction workflow together while independent sellers and
              producers retain responsibility for their goods.
            </p>
          </div>

          <div className="marketplace-grid">
            {pillars.map(([number, title, description]) => (
              <article className="market-card" key={number}>
                <span className="market-number">{number}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* TRANSACTION FLOW */}
      <section className="home-section home-section-alt">
        <div className="home-container">
          <div className="section-heading">
            <span className="eyebrow">MARKETPLACE TRANSACTION</span>
            <h2>Discover → Verify → Negotiate → Buy → Deliver</h2>
            <p>
              A structured marketplace journey designed to support real
              transactions from discovery through delivery and confirmation.
            </p>
          </div>

          <div className="process-shell">
            <div className="process-grid">
              <div className="process-item">
                <span className="process-number">01</span>
                <strong>Seller / Farmer lists</strong>
                <span>Products become available to buyers.</span>
              </div>

              <div className="process-item">
                <span className="process-number">02</span>
                <strong>Buyer discovers</strong>
                <span>Find available products and agricultural lots.</span>
              </div>

              <div className="process-item">
                <span className="process-number">03</span>
                <strong>Inspection / evidence</strong>
                <span>Quality information can support the transaction.</span>
              </div>

              <div className="process-item">
                <span className="process-number">04</span>
                <strong>Offer / negotiation</strong>
                <span>Buyers and sellers can negotiate where supported.</span>
              </div>

              <div className="process-item">
                <span className="process-number">05</span>
                <strong>Order & payment</strong>
                <span>The transaction moves into the order workflow.</span>
              </div>

              <div className="process-item">
                <span className="process-number">06</span>
                <strong>Own truck / hire transport</strong>
                <span>Delivery can use available transport options.</span>
              </div>

              <div className="process-item">
                <span className="process-number">07</span>
                <strong>Delivery</strong>
                <span>The product moves to the buyer.</span>
              </div>

              <div className="process-item">
                <span className="process-number">08</span>
                <strong>Buyer confirms receipt</strong>
                <span>The marketplace transaction reaches confirmation.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="home-section">
        <div className="home-container">
          <div className="final-cta">
            <div className="final-cta-content">
              <span className="eyebrow">JOIN MARKETBRIDGE</span>

              <h2>Buy, sell, produce and participate in one platform.</h2>

              <p>
                Choose the marketplace that fits what you want to buy or sell,
                then continue through the marketplace workflow built around
                independent participants.
              </p>

              <div className="final-actions">
                <Link
                  className="home-btn home-btn-primary"
                  to="/agricultural"
                >
                  Agricultural
                </Link>

                <Link className="home-btn home-btn-light" to="/products">
                  Products
                </Link>

                <Link className="home-btn home-btn-light" to="/digital">
                  Digital
                </Link>

                <Link className="home-btn home-btn-light" to="/register">
                  Create Account
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
