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

module.exports = { requireRole, requireAllRoles };
