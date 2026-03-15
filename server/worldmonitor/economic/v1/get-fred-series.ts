/**
 * RPC: getFredSeries -- reads seeded FRED time series data from Railway seed cache.
 * All external FRED API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetFredSeriesRequest,
  GetFredSeriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const FRED_KEY_PREFIX = 'economic:fred:v1';

export async function getFredSeries(
  _ctx: ServerContext,
  req: GetFredSeriesRequest,
): Promise<GetFredSeriesResponse> {
  if (!req.seriesId) return { series: undefined };
  try {
    const seedKey = `${FRED_KEY_PREFIX}:${req.seriesId}:0`;
    const result = await getCachedJson(seedKey, true) as GetFredSeriesResponse | null;
    if (!result?.series) return { series: undefined };
    if (req.limit > 0 && result.series.observations.length > req.limit) {
      return { series: { ...result.series, observations: result.series.observations.slice(-req.limit) } };
    }
    return result;
  } catch {
    return { series: undefined };
  }
}
