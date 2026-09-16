const mongoose = require('mongoose');

const adAnalyticsSchema = new mongoose.Schema({
  adId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ad',
    required: true,
    index: true
  },
  campaignId: {
    type: String,
    index: true
  },
  platform: {
    type: String,
    enum: ['web', 'telegram', 'sms', 'social'],
    default: 'web'
  },
  metrics: {
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    totalSpend: { type: Number, default: 0.00 },
    totalRevenue: { type: Number, default: 0.00 },
    bounceRate: { type: Number, default: 0.00 },
    ctr: { type: Number, default: 0.00 },  // Calculated Click-Through Rate
    cvr: { type: Number, default: 0.00 },  // Calculated Conversion Rate
    roas: { type: Number, default: 0.00 }   // Return on Ad Spend
  },
  approvalStatus: {
    type: String,
    enum: ['pending_review', 'needs_optimization', 'approved_effective', 'rejected', 'boosted'],
    default: 'pending_review',
    index: true
  },
  evaluationMetadata: {
    recommendations: [String],
    evaluatedAt: Date
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('AdAnalytics', adAnalyticsSchema);
