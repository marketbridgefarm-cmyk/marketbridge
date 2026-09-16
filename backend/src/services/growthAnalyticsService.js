const prisma = require('../config/db');

// Production threshold configuration for ad performance evaluation
const PERFORMANCE_THRESHOLDS = {
  MIN_CTR: 2.5,        // 2.5% Click-Through Rate
  MIN_ROAS: 3.0        // 3.0x Return on Ad Spend (revenue / amount paid)
};

class GrowthAnalyticsService {
  /**
   * Build a marketplace growth/advertising summary for a single advertiser.
   * Pulls the advertiser's campaigns, their impression/click events, and
   * what they've paid, then rolls it up into headline KPIs plus a
   * per-campaign breakdown.
   */
  async getMarketplaceAnalytics(userId) {
    const advertisements = await prisma.advertisement.findMany({
      where: { advertiserId: userId },
      include: {
        events: { select: { eventType: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const campaigns = advertisements.map((ad) => {
      const impressions = ad.events.filter((e) => e.eventType === 'IMPRESSION').length;
      const clicks = ad.events.filter((e) => e.eventType === 'CLICK').length;
      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
      // Advertisement.amountPaid is kept in sync by paymentService on each
      // successful ADVERTISING payment (see paymentService.js) — no need to
      // re-derive it from the payments relation, and Payment's own amount
      // field is called `amount`, not `amountPaid`.
      const spend = Number(ad.amountPaid || 0);

      return {
        id: ad.id,
        campaignReference: ad.campaignReference,
        type: ad.type,
        status: ad.status,
        startDate: ad.startDate,
        endDate: ad.endDate,
        impressions,
        clicks,
        ctr: parseFloat(ctr.toFixed(2)),
        spend: parseFloat(spend.toFixed(2)),
        meetsCtrTarget: ctr >= PERFORMANCE_THRESHOLDS.MIN_CTR
      };
    });

    const totals = campaigns.reduce(
      (acc, c) => {
        acc.impressions += c.impressions;
        acc.clicks += c.clicks;
        acc.spend += c.spend;
        return acc;
      },
      { impressions: 0, clicks: 0, spend: 0 }
    );

    const overallCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
    const activeCampaigns = campaigns.filter((c) => ['PUBLISHED', 'ACTIVE', 'SCHEDULED'].includes(c.status)).length;

    return {
      totals: {
        campaignCount: campaigns.length,
        activeCampaigns,
        impressions: totals.impressions,
        clicks: totals.clicks,
        ctr: parseFloat(overallCtr.toFixed(2)),
        spend: parseFloat(totals.spend.toFixed(2))
      },
      thresholds: PERFORMANCE_THRESHOLDS,
      campaigns
    };
  }

  /**
   * Record an impression or click event against an advertisement.
   */
  async logCampaignEvent(advertisementId, eventType = 'IMPRESSION') {
    return prisma.advertisementEvent.create({
      data: { advertisementId, eventType }
    });
  }
}

module.exports = new GrowthAnalyticsService();
