import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// Friendly, action-oriented copy for switching into each of the user's
// other roles — replaces flat "Buyer" / "Seller" navbar labels with a
// contextual prompt shown on the dashboard itself.
const ROLE_INFO = {
  BUYER: { icon: '🛒', href: '/dashboard/buyer', question: 'What do you want to buy today?', hint: 'Browse fresh listings and place an order.', cta: 'Buy something' },
  SELLER: { icon: '🌾', href: '/dashboard/seller', question: 'Got something to sell?', hint: 'List your harvest or product for buyers to find.', cta: 'List an item' },
  INSPECTOR: { icon: '🔍', href: '/dashboard/inspector', question: 'Inspections waiting on you?', hint: 'Review requests and file quality reports.', cta: 'Inspections' },
  TRUCK_OWNER: { icon: '🚛', href: '/dashboard/truck-owner', question: 'Got a truck to put to work?', hint: 'Find hire requests and manage your fleet.', cta: 'Transport' },
  ADVERTISER: { icon: '📣', href: '/dashboard/advertiser', question: 'Want more eyes on a listing?', hint: 'Run a featured or banner campaign.', cta: 'Advertise' },
  ADMIN: { icon: '🛠️', href: '/dashboard/admin', question: 'Head to the control center.', hint: 'Users, disputes, and platform oversight.', cta: 'Admin' },
};

// The natural "opposite" of buying and selling — featured first when the
// user has it, since it's the most common cross-sell (every account starts
// with both roles).
const OPPOSITE = { BUYER: 'SELLER', SELLER: 'BUYER' };

export default function RoleSwitchCTA({ current }) {
  const { user } = useAuth();
  if (!user) return null;

  const otherRoles = (user.roles || []).filter((r) => r !== current && ROLE_INFO[r]);
  if (otherRoles.length === 0) return null;

  const featuredRole =
    OPPOSITE[current] && otherRoles.includes(OPPOSITE[current])
      ? OPPOSITE[current]
      : otherRoles[0];

  const featured = ROLE_INFO[featuredRole];
  const rest = otherRoles.filter((r) => r !== featuredRole);

  return (
    <div className="role-cta">
      <div className="role-cta-text">
        <span className="role-cta-icon">{featured.icon}</span>
        <div>
          <strong>{featured.question}</strong>
          <span>{featured.hint}</span>
        </div>
      </div>
      <div className="role-cta-links">
        <Link className="btn btn-primary" to={featured.href}>{featured.question}</Link>
        {rest.map((r) => (
          <Link key={r} className="btn btn-light btn-sm" to={ROLE_INFO[r].href}>
            {ROLE_INFO[r].icon} {ROLE_INFO[r].cta}
          </Link>
        ))}
      </div>
    </div>
  );
}
