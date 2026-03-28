// PreMeet feature requests
// Stores feature requests and user votes in chrome.storage.local.
// Will migrate to Neon for cross-user sharing when the backend API is ready.

import type { FeatureRequest } from '../types';

const STORAGE_KEY = 'pm_feature_requests';
const VOTES_KEY = 'pm_feature_votes';

// ─── Seed data ────────────────────────────────────────────────────────────────

const SEED_REQUESTS: FeatureRequest[] = [
  {
    id: 'fr-1',
    title: 'LinkedIn profile enrichment',
    description: 'Pull LinkedIn data for meeting attendees automatically.',
    votes: 42,
    upvotedByUser: false,
    createdAt: Date.now() - 7 * 86400_000,
  },
  {
    id: 'fr-2',
    title: 'Company news & recent announcements',
    description: "Show the attendee's company latest news before the meeting.",
    votes: 31,
    upvotedByUser: false,
    createdAt: Date.now() - 5 * 86400_000,
  },
  {
    id: 'fr-3',
    title: 'Meeting agenda AI summary',
    description: 'Auto-generate a prep checklist from the meeting description.',
    votes: 27,
    upvotedByUser: false,
    createdAt: Date.now() - 3 * 86400_000,
  },
  {
    id: 'fr-4',
    title: 'CRM integration (Salesforce / HubSpot)',
    description: 'Sync attendee context with your CRM automatically.',
    votes: 19,
    upvotedByUser: false,
    createdAt: Date.now() - 2 * 86400_000,
  },
  {
    id: 'fr-5',
    title: 'Email pre-meeting brief delivery',
    description: 'Send the brief to your inbox 30 minutes before the meeting.',
    votes: 14,
    upvotedByUser: false,
    createdAt: Date.now() - 1 * 86400_000,
  },
];

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function loadRaw(): Promise<{ requests: FeatureRequest[]; votedIds: Set<string> }> {
  const result = await chrome.storage.local.get([STORAGE_KEY, VOTES_KEY]);
  const requests: FeatureRequest[] = result[STORAGE_KEY] ?? SEED_REQUESTS;
  const votedIds = new Set<string>((result[VOTES_KEY] ?? []) as string[]);
  return { requests, votedIds };
}

async function save(requests: FeatureRequest[], votedIds: Set<string>): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY]: requests,
    [VOTES_KEY]: [...votedIds],
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getFeatureRequests(): Promise<FeatureRequest[]> {
  const { requests, votedIds } = await loadRaw();
  return requests
    .map((r) => ({ ...r, upvotedByUser: votedIds.has(r.id) }))
    .sort((a, b) => b.votes - a.votes);
}

export async function upvoteRequest(id: string): Promise<FeatureRequest[]> {
  const { requests, votedIds } = await loadRaw();
  if (votedIds.has(id)) return getFeatureRequests(); // already voted

  const updated = requests.map((r) => (r.id === id ? { ...r, votes: r.votes + 1 } : r));
  votedIds.add(id);
  await save(updated, votedIds);
  return getFeatureRequests();
}

export async function removeUpvote(id: string): Promise<FeatureRequest[]> {
  const { requests, votedIds } = await loadRaw();
  if (!votedIds.has(id)) return getFeatureRequests(); // not voted

  const updated = requests.map((r) =>
    r.id === id ? { ...r, votes: Math.max(0, r.votes - 1) } : r
  );
  votedIds.delete(id);
  await save(updated, votedIds);
  return getFeatureRequests();
}

export async function addFeatureRequest(title: string, description: string): Promise<FeatureRequest[]> {
  const { requests, votedIds } = await loadRaw();
  const newRequest: FeatureRequest = {
    id: `fr-${Date.now()}`,
    title: title.trim(),
    description: description.trim(),
    votes: 1,
    upvotedByUser: true,
    createdAt: Date.now(),
  };
  votedIds.add(newRequest.id);
  await save([...requests, newRequest], votedIds);
  return getFeatureRequests();
}
