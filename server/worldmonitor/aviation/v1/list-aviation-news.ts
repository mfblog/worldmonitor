import type {
    ServerContext,
    ListAviationNewsRequest,
    ListAviationNewsResponse,
    AviationNewsItem,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const CACHE_TTL = 900; // 15 minutes

const AVIATION_RSS_FEEDS = [
    { url: 'https://www.flightglobal.com/rss', name: 'FlightGlobal' },
    { url: 'https://simpleflying.com/feed/', name: 'Simple Flying' },
    { url: 'https://aerotime.aero/feed', name: 'AeroTime' },
    { url: 'https://thepointsguy.com/feed/', name: 'The Points Guy' },
];

interface RssItem {
    title?: string;
    link?: string;
    pubDate?: string;
    description?: string;
    [key: string]: unknown;
}

function extractText(xmlStr: string, tag: string): string {
    const m = xmlStr.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return (m?.[1] ?? m?.[2] ?? '').trim();
}

function parseRssItems(xml: string, sourceName: string): RssItem[] {
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
    return itemMatches.slice(0, 30).map(itemXml => ({
        title: extractText(itemXml, 'title'),
        link: extractText(itemXml, 'link') || extractText(itemXml, 'guid'),
        pubDate: extractText(itemXml, 'pubDate'),
        description: extractText(itemXml, 'description'),
        _source: sourceName,
    }));
}

function matchesEntities(text: string, entities: string[]): string[] {
    if (!entities.length) return [];
    const lower = text.toLowerCase();
    return entities.filter(e => lower.includes(e.toLowerCase()));
}

async function fetchFeed(feedUrl: string, sourceName: string): Promise<RssItem[]> {
    try {
        const resp = await fetch(feedUrl, {
            headers: {
                'User-Agent': CHROME_UA,
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            },
            signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) return [];
        const xml = await resp.text();
        return parseRssItems(xml, sourceName);
    } catch {
        return [];
    }
}

export async function listAviationNews(
    _ctx: ServerContext,
    req: ListAviationNewsRequest,
): Promise<ListAviationNewsResponse> {
    const entities = req.entities ?? [];
    const windowMs = (req.windowHours ?? 24) * 60 * 60 * 1000;
    const maxItems = Math.min(req.maxItems ?? 20, 50);
    const cacheKey = `aviation:news:${entities.sort().join(',')}:${req.windowHours}:v1`;
    const now = Date.now();

    try {
        const result = await cachedFetchJson<{ items: AviationNewsItem[] }>(
            cacheKey, CACHE_TTL, async () => {
                const allItems: RssItem[] = [];

                await Promise.allSettled(
                    AVIATION_RSS_FEEDS.map(f => fetchFeed(f.url, f.name).then(items => allItems.push(...items)))
                );

                const cutoff = now - windowMs;
                const filtered: AviationNewsItem[] = [];

                for (const item of allItems) {
                    const title = item.title ?? '';
                    const link = item.link ?? '';
                    if (!title || !link) continue;

                    let publishedAt = 0;
                    if (item.pubDate) {
                        try { publishedAt = new Date(item.pubDate as string).getTime(); } catch { /* skip */ }
                    }
                    if (publishedAt && publishedAt < cutoff) continue;

                    const textToSearch = `${title} ${item.description ?? ''}`;
                    const matched = matchesEntities(textToSearch, entities);
                    if (entities.length > 0 && matched.length === 0) continue;

                    const snippet = (item.description as string | undefined ?? '').replace(/<[^>]+>/g, '').slice(0, 200);

                    filtered.push({
                        id: Buffer.from(link).toString('base64').slice(0, 32),
                        title,
                        url: link,
                        sourceName: (item._source as string) ?? 'Aviation News',
                        publishedAt: publishedAt || now,
                        snippet,
                        matchedEntities: matched,
                        imageUrl: '',
                    });
                }

                // Sort by newest first
                filtered.sort((a, b) => b.publishedAt - a.publishedAt);

                return { items: filtered.slice(0, maxItems) };
            }
        );

        return {
            items: result?.items ?? [],
            source: 'rss',
            updatedAt: now,
        };
    } catch (err) {
        console.warn(`[Aviation] ListAviationNews failed: ${err instanceof Error ? err.message : err}`);
        return { items: [], source: 'error', updatedAt: now };
    }
}
