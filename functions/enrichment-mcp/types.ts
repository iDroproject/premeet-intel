// PreMeet — CompanyIntel type for MCP enrichment
// Extends the existing CompanyData concept with Crunchbase + ZoomInfo fields

export interface CompanyIntel {
  // Crunchbase fields
  crunchbaseUrl: string | null;
  totalFunding: string | null;
  lastFundingRound: { type: string; amount: string; date: string } | null;
  investors: Array<{ name: string; leadInvestor: boolean }>;
  ipoStatus: string | null;
  acquisitions: number | null;

  // ZoomInfo fields
  employeeCount: number | null;
  employeeGrowth6m: number | null;
  techStack: string[];
  intentTopics: string[];
  departmentBreakdown: Record<string, number> | null;
}

export interface McpToolResult {
  toolName: string;
  data: Record<string, unknown> | null;
  error: string | null;
  latencyMs: number;
}

export interface EnrichmentMcpRequest {
  companyName: string;
  companyDomain?: string;
}

export interface EnrichmentMcpResponse {
  data: CompanyIntel;
  sources: {
    crunchbase: { success: boolean; cached: boolean };
    zoominfo: { success: boolean; cached: boolean };
  };
  cached: boolean;
  fetchedAt: string;
}
