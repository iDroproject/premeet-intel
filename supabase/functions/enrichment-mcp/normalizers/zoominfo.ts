// PreMeet — ZoomInfo MCP Response Normalizer
// Maps BrightData web_data_zoominfo_company_profile response → CompanyIntel fields

import type { CompanyIntel } from '../types.ts';

export function normalizeZoominfo(raw: Record<string, unknown>): Partial<CompanyIntel> {
  // Extract tech stack
  const techStack: string[] = [];
  const rawTech = raw.tech_stack || raw.technologies || raw.technology_names;
  if (Array.isArray(rawTech)) {
    for (const t of rawTech) {
      if (typeof t === 'string') techStack.push(t);
      else if (t && typeof t === 'object' && 'name' in (t as Record<string, unknown>)) {
        techStack.push(String((t as Record<string, unknown>).name));
      }
    }
  }

  // Extract intent topics
  const intentTopics: string[] = [];
  const rawIntent = raw.intent_topics || raw.intent_signals || raw.topics;
  if (Array.isArray(rawIntent)) {
    for (const topic of rawIntent) {
      if (typeof topic === 'string') intentTopics.push(topic);
      else if (topic && typeof topic === 'object') {
        const rec = topic as Record<string, unknown>;
        intentTopics.push(String(rec.topic || rec.name || rec.signal || ''));
      }
    }
  }

  // Extract department breakdown
  let departmentBreakdown: Record<string, number> | null = null;
  const rawDepts = raw.department_breakdown || raw.departments || raw.department_headcount;
  if (rawDepts && typeof rawDepts === 'object' && !Array.isArray(rawDepts)) {
    departmentBreakdown = {};
    for (const [dept, count] of Object.entries(rawDepts as Record<string, unknown>)) {
      const num = Number(count);
      if (!isNaN(num)) departmentBreakdown[dept] = num;
    }
    if (Object.keys(departmentBreakdown).length === 0) departmentBreakdown = null;
  } else if (Array.isArray(rawDepts)) {
    departmentBreakdown = {};
    for (const d of rawDepts) {
      if (d && typeof d === 'object') {
        const rec = d as Record<string, unknown>;
        const name = String(rec.name || rec.department || '');
        const count = Number(rec.count || rec.headcount || 0);
        if (name && count > 0) departmentBreakdown[name] = count;
      }
    }
    if (Object.keys(departmentBreakdown).length === 0) departmentBreakdown = null;
  }

  // Employee growth
  let employeeGrowth6m: number | null = null;
  if (raw.employee_growth_6m != null) {
    employeeGrowth6m = Number(raw.employee_growth_6m) || null;
  } else if (raw.employee_growth != null) {
    employeeGrowth6m = Number(raw.employee_growth) || null;
  } else if (raw.growth_rate != null) {
    employeeGrowth6m = Number(raw.growth_rate) || null;
  }

  return {
    employeeCount: raw.employee_count != null
      ? Number(raw.employee_count) || null
      : raw.employees != null
        ? Number(raw.employees) || null
        : raw.number_of_employees != null
          ? Number(raw.number_of_employees) || null
          : null,
    employeeGrowth6m,
    techStack,
    intentTopics,
    departmentBreakdown,
  };
}
