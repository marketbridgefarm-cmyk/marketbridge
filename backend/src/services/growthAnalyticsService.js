const knex = require('../database/knex'); // Knex instance connected to PostgreSQL database

// Production threshold configuration for ad performance evaluation
const PERFORMANCE_THRESHOLDS = {
  MIN_CTR: 2.5,        // 2.5% Click-Through Rate
  MIN_CVR: 1.8,        // 1.8% Conversion Rate
  MIN_ROAS: 3.0,       // 3.0x Return on Ad Spend
  MAX_BOUNCE: 45.0     // 45% Bounce Rate Ceiling
};

class GrowthAnalyticsService {
  /**
   * Log an outgoing promotional broadcast event in the database
   */
  async logCampaignBroadcast(campaignId, platform = 'telegram', adId = null) {
    try {
      const [logRecord] = await knex('ad_performance_logs')
        .insert({
          ad_id: adId,
          campaign_id: campaignId,
          platform: platform,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          spend: 0.00,
          revenue: 0.00,
          bounce_rate: 0.0,
          recorded_at: new Date()
        })
        .returning('*');

      console.log(`[Analytics] Campaign ${campaignId} broadcast logged for platform ${platform}.`);
      return logRecord;
    } catch (error) {
      console.error('Error logging campaign broadcast to database:', error.message);
      throw error;
    }
  }

  /**
   * Evaluates ad performance KPIs, updates database records, and logs performance metrics.
   * 
   * @param {Object} params
   * @param {string} params.adId - UUID of the ad record
   * @param {string} [params.campaignId] - Optional tracking campaign ID
   * @param {string} [params.platform='web'] - Platform source (web, telegram, sms)
   * @param {number} params.impressions - Number of ad views
   * @param {number} params.clicks - Number of ad clicks
   * @param {number} [params.conversions=0] - Total completed orders
   * @param {number} params.totalSpend - Cost incurred for the ad
   * @param {number} [params.totalRevenue=0.00] - Revenue generated from ad conversions
   * @param {number} [params.bounceRate=0.0] - Landing page bounce percentage
   */
  async evaluateAndPersistAdEffectiveness({
    adId,
    campaignId = null,
    platform = 'web',
    impressions = 0,
    clicks = 0,
    conversions = 0,
    totalSpend = 0,
    totalRevenue = 0,
    bounceRate = 0.0
  }) {
    // 1. Compute Key Analytics Indicators
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const cvr = clicks > 0 ? (conversions / clicks) * 100 : 0;
    const roas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

    // 2. Determine Approval Status & Recommendations based on thresholds
    const isEffective = 
      ctr >= PERFORMANCE_THRESHOLDS.MIN_CTR &&
      cvr >= PERFORMANCE_THRESHOLDS.MIN_CVR &&
      roas >= PERFORMANCE_THRESHOLDS.MIN_ROAS &&
      bounceRate <= PERFORMANCE_THRESHOLDS.MAX_BOUNCE;

    const status = isEffective ? 'approved_effective' : 'needs_optimization';
    const recommendations = isEffective
      ? ['Eligible for automated homepage carousel boost', 'Qualified for higher daily budget allocation']
      : ['Refine regional target filters', 'Refresh banner visual asset or offer seasonal discount'];

    const evaluationTimestamp = new Date();

    // 3. Execute Database Operations inside a Transaction
    return await knex.transaction(async (trx) => {
      // Record immutable metric log entry in ad_performance_logs table
      const [performanceLog] = await trx('ad_performance_logs')
        .insert({
          ad_id: adId,
          campaign_id: campaignId,
          platform: platform,
          impressions: Number(impressions),
          clicks: Number(clicks),
          conversions: Number(conversions),
          spend: Number(totalSpend),
          revenue: Number(totalRevenue),
          bounce_rate: Number(bounceRate),
          recorded_at: evaluationTimestamp
        })
        .returning('*');

      // Update main ads table with updated calculated KPIs and approval state
      const [updatedAd] = await trx('ads')
        .where({ id: adId })
        .update({
          approval_status: status,
          ctr: parseFloat(ctr.toFixed(2)),
          cvr: parseFloat(cvr.toFixed(2)),
          roas: parseFloat(roas.toFixed(2)),
          last_evaluated_at: evaluationTimestamp,
          evaluation_metadata: JSON.stringify({
            recommendations,
            evaluatedBy: 'GrowthAnalyticsEngine',
            thresholdsUsed: PERFORMANCE_THRESHOLDS
          })
        })
        .returning('*');

      return {
        ad: updatedAd,
        log: performanceLog,
        evaluation: {
          status,
          metrics: {
            ctr: parseFloat(ctr.toFixed(2)),
            cvr: parseFloat(cvr.toFixed(2)),
            roas: parseFloat(roas.toFixed(2)),
            bounceRate
          },
          recommendations
        }
      };
    });
  }
}

module.exports = new GrowthAnalyticsService();
