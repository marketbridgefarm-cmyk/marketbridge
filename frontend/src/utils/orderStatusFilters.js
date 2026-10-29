// Order status filters shared by the Orders page and the Dashboard orders tab.
// Buckets map onto the backend OrderStatus enum.
export const ORDER_STATUS_FILTERS = [
  { id: 'all',       label: 'All orders',       icon: 'list',      statuses: null },
  { id: 'pending',   label: 'Awaiting payment', icon: 'clock',     statuses: ['PENDING_PAYMENT'] },
  { id: 'progress',  label: 'In progress',      icon: 'truck',     statuses: ['CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT'] },
  { id: 'delivered', label: 'Delivered',        icon: 'package',   statuses: ['DELIVERED'] },
  { id: 'completed', label: 'Completed',        icon: 'check',     statuses: ['COMPLETED'] },
  { id: 'disputed',  label: 'Disputed',         icon: 'alert',     statuses: ['DISPUTED'] },
  { id: 'cancelled', label: 'Cancelled',        icon: 'cancel',    statuses: ['CANCELLED'] },
];

export function matchesOrderStatus(order, filterId) {
  const f = ORDER_STATUS_FILTERS.find((x) => x.id === filterId);
  if (!f || !f.statuses) return true;
  return f.statuses.includes(String(order?.status || '').toUpperCase());
}

// Choices for <FilterFab choices=…> with a live count on each button.
export function orderStatusChoices(orders = []) {
  return ORDER_STATUS_FILTERS.map((f) => ({
    id: f.id,
    label: f.label,
    icon: f.icon,
    count: orders.filter((o) => matchesOrderStatus(o, f.id)).length,
  }));
}
