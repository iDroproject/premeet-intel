// PreMeet — Fallback Chain Executor
// Generic progressive enrichment engine: tries data sources in order,
// returns the first success, and optionally continues enriching in background.

export type EnrichmentLevel = 'cache' | 'basic' | 'standard' | 'deep';

export interface LayerResult<T> {
  data: T;
  source: string;
  level: EnrichmentLevel;
  latencyMs: number;
  fields: number;
}

export interface FallbackLayer<T> {
  name: string;
  level: EnrichmentLevel;
  /** Execute the layer. Return data or null to skip to next layer. */
  execute: () => Promise<T | null>;
}

export interface FallbackChainResult<T> {
  data: T | null;
  source: string;
  level: EnrichmentLevel;
  latencyMs: number;
  /** Which layers were tried and their outcomes */
  layerLog: Array<{ name: string; status: 'success' | 'failed' | 'skipped'; latencyMs: number; error?: string }>;
}

/**
 * Execute a fallback chain: try each layer in order, return the first success.
 *
 * @param layers - Ordered list of data source layers to try
 * @param label  - Log prefix for debugging
 */
export async function executeFallbackChain<T>(
  layers: FallbackLayer<T>[],
  label: string,
): Promise<FallbackChainResult<T>> {
  const chainStart = performance.now();
  const layerLog: FallbackChainResult<T>['layerLog'] = [];

  for (const layer of layers) {
    const layerStart = performance.now();
    try {
      const result = await layer.execute();
      const latencyMs = Math.round(performance.now() - layerStart);

      if (result !== null) {
        layerLog.push({ name: layer.name, status: 'success', latencyMs });
        console.log(`[${label}] ${layer.name} succeeded in ${latencyMs}ms`);
        return {
          data: result,
          source: layer.name,
          level: layer.level,
          latencyMs: Math.round(performance.now() - chainStart),
          layerLog,
        };
      }

      // null = no data, skip to next
      layerLog.push({ name: layer.name, status: 'skipped', latencyMs });
      console.log(`[${label}] ${layer.name} returned no data (${latencyMs}ms), trying next`);
    } catch (err) {
      const latencyMs = Math.round(performance.now() - layerStart);
      const errorMsg = (err as Error).message;
      layerLog.push({ name: layer.name, status: 'failed', latencyMs, error: errorMsg });
      console.warn(`[${label}] ${layer.name} failed (${latencyMs}ms): ${errorMsg}`);
    }
  }

  // All layers exhausted
  return {
    data: null,
    source: 'none',
    level: 'basic',
    latencyMs: Math.round(performance.now() - chainStart),
    layerLog,
  };
}
