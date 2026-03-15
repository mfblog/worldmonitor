/**
 * RPC: getFredSeriesBatch -- reads seeded FRED data from Railway seed cache.
 * All external FRED API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetFredSeriesBatchRequest,
  GetFredSeriesBatchResponse,
  FredSeries,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { toUniqueSortedLimited } from '../../../_shared/normalize-list';

const FRED_KEY_PREFIX = 'economic:fred:v1';

const ALLOWED_SERIES = new Set([
  'WALCL', 'FEDFUNDS', 'T10Y2Y', 'UNRATE', 'CPIAUCSL', 'DGS10', 'VIXCLS',
  'GDP', 'M2SL', 'DCOILWTICO',
]);

export async function getFredSeriesBatch(
  _ctx: ServerContext,
  req: GetFredSeriesBatchRequest,
): Promise<GetFredSeriesBatchResponse> {
  try {
    const normalized = req.seriesIds
      .map((id) => id.trim().toUpperCase())
      .filter((id) => ALLOWED_SERIES.has(id));
    const limitedList = toUniqueSortedLimited(normalized, 10);
    const limit = req.limit > 0 ? Math.min(req.limit, 1000) : 120;

    const settled = await Promise.allSettled(
      limitedList.map((id) => getCachedJson(`${FRED_KEY_PREFIX}:${id}:0`, true)),
    );

    const results: Record<string, FredSeries> = {};
    for (let i = 0; i < limitedList.length; i++) {
      const id = limitedList[i]!;
      const entry = settled[i];
      if (entry?.status !== 'fulfilled' || !entry.value) continue;
      const cached = entry.value as { series?: FredSeries };
      if (cached?.series) {
        const series = cached.series;
        if (limit > 0 && series.observations.length > limit) {
          results[id] = { ...series, observations: series.observations.slice(-limit) };
        } else {
          results[id] = series;
        }
      }
    }

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
    };
  } catch {
    return { results: {}, fetched: 0, requested: 0 };
  }
}
