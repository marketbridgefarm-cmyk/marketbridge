'use strict';

const DEFAULT_TIMEOUT_HOURS = 48;
const DEFAULT_INSPECTION_WORKFLOW_TIMEOUT_HOURS = 48;
const DEFAULT_TRANSPORT_WORKFLOW_TIMEOUT_HOURS = 48;

/**
 * How long a buyer has to pay before an order is automatically cancelled
 * and its provisional order released back to the listing queue. Inventory is
 * committed only when goods payment settles. Configurable via
 * ORDER_PAYMENT_TIMEOUT_HOURS so Alex can tune it without a code change
 * (e.g. shorter for fast-moving produce, longer if bank/Telebirr transfers
 * commonly take a day or two to clear).
 */
function paymentTimeoutHours() {
  const configured = Number(process.env.ORDER_PAYMENT_TIMEOUT_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_HOURS;
}

function computePaymentDueAt(from = new Date()) {
  return new Date(from.getTime() + paymentTimeoutHours() * 60 * 60 * 1000);
}

module.exports = { paymentTimeoutHours, computePaymentDueAt, inspectionWorkflowTimeoutHours, transportWorkflowTimeoutHours, computeInspectionWorkflowDueAt, computeTransportWorkflowDueAt };


function workflowTimeoutHours(envName, fallback) {
  const configured = Number(process.env[envName]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function inspectionWorkflowTimeoutHours() {
  return workflowTimeoutHours('INSPECTION_WORKFLOW_TIMEOUT_HOURS', DEFAULT_INSPECTION_WORKFLOW_TIMEOUT_HOURS);
}

function transportWorkflowTimeoutHours() {
  return workflowTimeoutHours('TRANSPORT_WORKFLOW_TIMEOUT_HOURS', DEFAULT_TRANSPORT_WORKFLOW_TIMEOUT_HOURS);
}

function computeInspectionWorkflowDueAt(from = new Date()) {
  return new Date(from.getTime() + inspectionWorkflowTimeoutHours() * 60 * 60 * 1000);
}

function computeTransportWorkflowDueAt(from = new Date()) {
  return new Date(from.getTime() + transportWorkflowTimeoutHours() * 60 * 60 * 1000);
}
