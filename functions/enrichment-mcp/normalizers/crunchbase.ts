// PreMeet — Crunchbase MCP Response Normalizer
// Maps BrightData web_data_crunchbase_company response → CompanyIntel fields

import type { CompanyIntel } from '../types.ts';

export function normalizeCrunchbase(raw: Record<string, unknown>): Partial<CompanyIntel> {
  // Extract investors array
  const investors: Array<{ name: string; leadInvestor: boolean }> = [];
  const rawInvestors = raw.investors || raw.investor_list || raw.notable_investors;
  if (Array.isArray(rawInvestors)) {
    for (const inv of rawInvestors) {
      if (typeof inv === 'string') {
        investors.push({ name: inv, leadInvestor: false });
      } else if (inv && typeof inv === 'object') {
        const rec = inv as Record<string, unknown>;
        investors.push({
          name: String(rec.name || rec.investor_name || ''),
          leadInvestor: Boolean(rec.lead_investor || rec.is_lead || false),
        });
      }
    }
  }

  // Extract last funding round
  let lastFundingRound: CompanyIntel['lastFundingRound'] = null;
  const rawRound = raw.last_funding_round || raw.latest_round || raw.last_round;
  if (rawRound && typeof rawRound === 'object') {
    const round = rawRound as Record<string, unknown>;
    lastFundingRound = {
      type: String(round.type || round.round_type || round.funding_type || ''),
      amount: String(round.amount || round.money_raised || ''),
      date: String(round.date || round.announced_on || ''),
    };
  } else if (typeof raw.last_funding_type === 'string') {
    lastFundingRound = {
      type: String(raw.last_funding_type),
      amount: String(raw.last_funding_amount || raw.funding_total || ''),
      date: String(raw.last_funding_date || ''),
    };
  }

  // Extract acquisitions count
  let acquisitions: number | null = null;
  if (raw.num_acquisitions != null) {
    acquisitions = Number(raw.num_acquisitions) || null;
  } else if (raw.acquisitions != null) {
    if (typeof raw.acquisitions === 'number') acquisitions = raw.acquisitions;
    else if (Array.isArray(raw.acquisitions)) acquisitions = raw.acquisitions.length;
  }

  return {
    crunchbaseUrl: raw.crunchbase_url
      ? String(raw.crunchbase_url)
      : raw.url
        ? String(raw.url)
        : null,
    totalFunding: raw.total_funding
      ? String(raw.total_funding)
      : raw.funding_total
        ? String(raw.funding_total)
        : raw.total_funding_amount
          ? String(raw.total_funding_amount)
          : null,
    lastFundingRound,
    investors,
    ipoStatus: raw.ipo_status
      ? String(raw.ipo_status)
      : raw.stock_symbol
        ? 'public'
        : null,
    acquisitions,
  };
}
