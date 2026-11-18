import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchDataset, SEARCH_DATASETS } from '../../api/_shared/search-dataset';

function mockFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void) {
  return vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchDataset', () => {
  it('POSTs to the search endpoint with a single filter passed through as-is', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    vi.stubGlobal('fetch', mockFetch(200, { hits: [{ id: 'x' }], total_hits: 1, took: 42 }, (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
    }));

    const res = await searchDataset(
      SEARCH_DATASETS.peopleProfiles,
      [{ name: 'linkedin_id', operator: '=', value: 'egor' }],
      'KEY',
      { size: 1 },
    );

    expect(capturedUrl).toBe(`https://api.brightdata.com/datasets/search/${SEARCH_DATASETS.peopleProfiles}`);
    // Single filter passes through directly (not wrapped in an and-group).
    expect(capturedBody.filter).toEqual({ name: 'linkedin_id', operator: '=', value: 'egor' });
    expect(capturedBody.size).toBe(1);
    expect(res.records).toHaveLength(1);
    expect(res.totalHits).toBe(1);
    expect(res.tookMs).toBe(42);
    expect(res.error).toBeNull();
  });

  it('wraps multiple filters in an and-group', async () => {
    let capturedBody: any = null;
    vi.stubGlobal('fetch', mockFetch(200, { hits: [], total_hits: 0 }, (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
    }));

    await searchDataset(
      SEARCH_DATASETS.companyInfo,
      [
        { name: 'id', operator: '=', value: 'acme' },
        { name: 'country', operator: '=', value: 'US' },
      ],
      'KEY',
    );

    expect(capturedBody.filter).toEqual({
      operator: 'and',
      filters: [
        { name: 'id', operator: '=', value: 'acme' },
        { name: 'country', operator: '=', value: 'US' },
      ],
    });
  });

  it('treats 422 (no matches) as an empty result, not an error', async () => {
    vi.stubGlobal('fetch', mockFetch(422, 'no matches'));
    const res = await searchDataset(SEARCH_DATASETS.peopleProfiles, [{ name: 'linkedin_id', operator: '=', value: 'nobody' }], 'KEY');
    expect(res.records).toEqual([]);
    expect(res.error).toBeNull();
  });

  it('returns an error string on a 5xx', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'boom'));
    const res = await searchDataset(SEARCH_DATASETS.peopleProfiles, [{ name: 'linkedin_id', operator: '=', value: 'x' }], 'KEY');
    expect(res.records).toEqual([]);
    expect(res.error).toMatch(/HTTP 500/);
  });

  it('unwraps the hits envelope into plain records', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { hits: [{ a: 1 }, { a: 2 }], total_hits: 2, took: 5 }));
    const res = await searchDataset(SEARCH_DATASETS.peopleContactEnriched, [{ name: 'url', operator: '=', value: 'u' }], 'KEY', { size: 5 });
    expect(res.records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('unwraps an Elasticsearch-style { _source } envelope defensively', async () => {
    vi.stubGlobal('fetch', mockFetch(200, {
      hits: [{ _score: 1.2, _source: { name: 'Acme', id: 'acme' } }],
      total_hits: 1,
    }));
    const res = await searchDataset(SEARCH_DATASETS.companyInfo, [{ name: 'id', operator: '=', value: 'acme' }], 'KEY');
    expect(res.records).toEqual([{ name: 'Acme', id: 'acme' }]);
  });
});
