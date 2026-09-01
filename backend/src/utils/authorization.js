function hasRole(user, role) {
  return Array.isArray(user?.roles) && user.roles.includes(role);
}

function isAdmin(user) { return hasRole(user, 'ADMIN'); }
function isOrderParticipant(userId, order) { return !!order && (order.buyerId === userId || order.sellerId === userId); }
function isConversationParticipant(userId, order) {
  if (!order) return false;
  if (order.buyerId === userId || order.sellerId === userId) return true;
  return order.transportJob?.truckOwnerId === userId;
}
module.exports = { hasRole, isAdmin, isOrderParticipant, isConversationParticipant };
