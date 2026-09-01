// Usage: requireRole('ADMIN') or requireRole('SELLER', 'ADMIN')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const hasRole = req.user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      return res.status(403).json({ error: `Requires one of roles: ${allowedRoles.join(', ')}` });
    }
    next();
  };
}

module.exports = { requireRole };
