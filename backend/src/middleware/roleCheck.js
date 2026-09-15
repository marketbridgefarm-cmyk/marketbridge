// Usage: requireRole('ADMIN') or requireRole('SELLER', 'ADMIN')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Not authenticated',
        code: 'NOT_AUTHENTICATED',
      });
    }

    // Check if user has any of the allowed roles
    const hasRole = req.user.roles?.some((r) => allowedRoles.includes(r));

    if (!hasRole) {
      return res.status(403).json({
        error: `Requires one of roles: ${allowedRoles.join(', ')}`,
        code: 'INSUFFICIENT_ROLE',
        requiredRoles: allowedRoles,
        userRoles: req.user.roles,
      });
    }

    next();
  };
}

// Check if user has ALL specified roles
function requireAllRoles(...requiredRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Not authenticated',
        code: 'NOT_AUTHENTICATED',
      });
    }

    const hasAllRoles = requiredRoles.every((r) => req.user.roles?.includes(r));

    if (!hasAllRoles) {
      return res.status(403).json({
        error: `Requires all roles: ${requiredRoles.join(', ')}`,
        code: 'INSUFFICIENT_ROLES',
        requiredRoles,
        userRoles: req.user.roles,
      });
    }

    next();
  };
}

// Gate for routes that require the account to have MFA enabled — currently
// applied to admin-exclusive routes (see routes/admin.js, maintenance.js,
// disputes.js) since admin access is the highest-value target on the
// platform. Deliberately separate from requireRole so it composes cleanly:
// requireRole establishes *who* can be here, this establishes that the
// account has taken the extra step to protect that access. Existing admin
// accounts are not locked out by this shipping — they can still log in and
// use non-admin-only endpoints; this only blocks admin-only actions until
// they visit POST /auth/mfa/setup once.
function requireMfa() {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated', code: 'NOT_AUTHENTICATED' });
    }

    if (!req.user.mfaEnabled) {
      return res.status(403).json({
        error: 'This action requires multi-factor authentication to be enabled on your account. Set it up under Account Security, then try again.',
        code: 'MFA_SETUP_REQUIRED',
      });
    }

    next();
  };
}

module.exports = { requireRole, requireAllRoles, requireMfa };
