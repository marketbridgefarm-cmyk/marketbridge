'use strict';

// ============================================================================
// TRANSPORT COORDINATION SERVICE
// ============================================================================
//
// Thin re-export of the unified coordination service. The transport and
// inspection flows are now driven from services/coordinationService.js via
// a shared factory; this file preserves the existing import path so no
// caller needs to change.
// ============================================================================

module.exports = require('./coordinationService').transport;
