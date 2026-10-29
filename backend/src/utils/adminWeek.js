'use strict';

// Week buckets for the admin overview ("new orders and paid volume per day, Monday to Sunday").
// Days follow the marketplace's local time, not the server's UTC clock: Ethiopia is UTC+3 all year (no daylight saving),
// so a payment at 23:30 UTC on Wednesday belongs to Thursday for the admins reading the chart.
const envOffset = process.env.ADMIN_TZ_OFFSET_HOURS;
const DEFAULT_OFFSET_HOURS = envOffset !== undefined && envOffset !== '' && Number.isFinite(Number(envOffset)) ? Number(envOffset) : 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// "2026-10-29" for an instant, as seen at the given offset from UTC.
function dayKey(date, offsetHours = DEFAULT_OFFSET_HOURS) {
  return new Date(new Date(date).getTime() + offsetHours * HOUR_MS).toISOString().slice(0, 10);
}

// The Monday-to-Sunday week that contains `now`: the instant it starts, and its seven local dates.
function weekWindow(now = new Date(), offsetHours = DEFAULT_OFFSET_HOURS) {
  const local = new Date(new Date(now).getTime() + offsetHours * HOUR_MS);           // read with getUTC* = local wall clock
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - sinceMonday);
  return {
    start: new Date(mondayLocal - offsetHours * HOUR_MS),
    days: Array.from({ length: 7 }, (_, i) => new Date(mondayLocal + i * DAY_MS).toISOString().slice(0, 10)),
  };
}

// orders: [{ createdAt }], payments: [{ updatedAt, amount }] -> { weekStart, today, days: [{ date, orders, paidVolume }] }
function bucketWeek({ now = new Date(), orders = [], payments = [], offsetHours = DEFAULT_OFFSET_HOURS } = {}) {
  const win = weekWindow(now, offsetHours);
  const days = win.days.map((date) => ({ date, orders: 0, paidVolume: 0 }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const o of orders) {
    const d = byDate.get(dayKey(o.createdAt, offsetHours));
    if (d) d.orders += 1;
  }
  for (const p of payments) {
    const d = byDate.get(dayKey(p.updatedAt, offsetHours));
    if (d) d.paidVolume += Number(p.amount || 0);
  }
  return { weekStart: win.days[0], today: dayKey(now, offsetHours), days };
}

module.exports = { dayKey, weekWindow, bucketWeek, DEFAULT_OFFSET_HOURS };
