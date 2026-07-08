import type { AppData, Env } from '../_shared/types';

type ImageResult = {
  body: ArrayBuffer;
  type: string;
  url: URL;
};

const DOUBAN_IMAGE_HOSTS = /(^|\.)doubanio\.com$/i;
const NUMERIC_ID = /^\d{5,12}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const CACHE_REVISION = '11';
const POSTER_LOOKUP_REVISION = '2';
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
const IMAGE_HOST_ALTERNATES = [
  'img1.doubanio.com',
  'img2.doubanio.com',
  'img3.doubanio.com',
  'img9.doubanio.com',
  'qnmob3.doubanio.com',
];

const DOUBAN_IMAGE_HEADERS = {
  Accept: IMAGE_ACCEPT,
  Referer: 'https://movie.douban.com/',
  'User-Agent': DESKTOP_USER_AGENT,
};

function noStore(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function textAt(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function detectedImageType(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return '';

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && textAt(bytes, 1, 4) === 'PNG') return 'image/png';
  if (textAt(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (textAt(bytes, 0, 2) === 'BM') return 'image/bmp';

  if (textAt(bytes, 4, 8) === 'ftyp') {
    const brand = textAt(bytes, 8, 12).toLowerCase();
    if (['avif', 'avis', 'mif1', 'msf1', 'heic', 'heix'].includes(brand)) return 'image/avif';
  }

  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 768))).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return '';
}

function responseImageType(buffer: ArrayBuffer, contentType: string): string {
  const detected = detectedImageType(buffer);
  if (detected) return detected;

  const declared = contentType.split(';')[0].trim().toLowerCase();
  if (!declared.startsWith('image/')) return '';

  const head = new TextDecoder().decode(new Uint8Array(buffer).subarray(0, Math.min(buffer.byteLength, 512))).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('{') || head.startsWith('[')) return '';
  return declared;
}

function doubanImageUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  let source = value.trim().replace(/\\\//g, '/').replace(/&amp;/gi, '&');
  if (!source) return null;
  if (source.startsWith('//')) source = `https:${source}`;

  try {
    const url = new URL(source);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || !DOUBAN_IMAGE_HOSTS.test(url.hostname)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function addCandidate(output: URL[], seen: Set<string>, value: URL | null): void {
  if (!value || value.protocol !== 'https:' || !DOUBAN_IMAGE_HOSTS.test(value.hostname)) return;
  const key = value.toString();
  if (seen.has(key)) return;
  seen.add(key);
  output.push(value);
}

function imageCandidates(source: URL): URL[] {
  const output: URL[] = [];
  const seen = new Set<string>();
  const clean = new URL(source.toString());
  clean.protocol = 'https:';
  clean.hash = '';

  addCandidate(output, seen, new URL(clean.toString()));

  const withoutQuery = new URL(clean.toString());
  withoutQuery.search = '';
  addCandidate(output, seen, withoutQuery);

  const paths = new Set<string>([clean.pathname]);
  if (/\/view\/photo\/[^/]*ratio_poster\//i.test(clean.pathname)) {
    for (const size of ['l_ratio_poster', 'm_ratio_poster', 's_ratio_poster']) {
      paths.add(clean.pathname.replace(/\/view\/photo\/[^/]*ratio_poster\//i, `/view/photo/${size}/`));
    }
  }
  if (/\/view\/photo\/(?:raw|xl|l|m|s|sqx|sqxs)\/public\//i.test(clean.pathname)) {
    for (const size of ['l', 'm', 's', 'raw']) {
      paths.add(clean.pathname.replace(/\/view\/photo\/(?:raw|xl|l|m|s|sqx|sqxs)\/public\//i, `/view/photo/${size}/public/`));
    }
  }
  if (/\.webp$/i.test(clean.pathname)) paths.add(clean.pathname.replace(/\.webp$/i, '.jpg'));
  if (/\.jpe?g$/i.test(clean.pathname)) paths.add(clean.pathname.replace(/\.jpe?g$/i, '.webp'));

  for (const hostname of IMAGE_HOST_ALTERNATES) {
    for (const path of paths) {
      const candidate = new URL(clean.toString());
      candidate.hostname = hostname;
      candidate.pathname = path;
      candidate.search = '';
      candidate.hash = '';
      addCandidate(output, seen, candidate);
    }
  }

  return output.slice(0, 30);
}

async function fetchImageOnce(url: URL, headers: HeadersInit, timeoutMs: number): Promise<{ response: Response | null; body: ArrayBuffer | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return { response, body: null };

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) return { response, body: null };

    const body = await response.arrayBuffer();
    return { response, body };
  } catch {
    return { response: null, body: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchVerifiedImage(url: URL, timeoutMs = 5_000): Promise<ImageResult | null> {
  const headerAttempts: HeadersInit[] = [
    DOUBAN_IMAGE_HEADERS,
    { Accept: IMAGE_ACCEPT, 'User-Agent': MOBILE_USER_AGENT },
  ];

  for (const headers of headerAttempts) {
    const fetched = await fetchImageOnce(url, headers, timeoutMs);
    if (!fetched.response || !fetched.body) continue;
    if (fetched.body.byteLength < 64 || fetched.body.byteLength > MAX_IMAGE_BYTES) continue;

    const type = responseImageType(fetched.body, fetched.response.headers.get('content-type') || '');
    if (type) return { body: fetched.body, type, url };
  }

  return null;
}

async function firstVerifiedImage(candidates: URL[]): Promise<ImageResult | null> {
  if (!candidates.length) return null;

  const first = await fetchVerifiedImage(candidates[0]);
  if (first) return first;

  for (let index = 1; index < candidates.length; index += 4) {
    const results = await Promise.all(candidates.slice(index, index + 4).map(candidate => fetchVerifiedImage(candidate, 4_500)));
    const valid = results.find((value): value is ImageResult => Boolean(value));
    if (valid) return valid;
  }

  return null;
}

async function fetchMetadata(url: URL, accept: string, referer: string, timeoutMs = 6_000): Promise<{ text: string; contentType: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Accept: accept,
        Referer: referer,
        'User-Agent': DESKTOP_USER_AGENT,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_METADATA_BYTES) return null;

    const text = await response.text();
    if (!text || text.length > MAX_METADATA_BYTES) return null;
    return { text, contentType: response.headers.get('content-type') || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function posterFromJson(payload: any): URL | null {
  const roots = [payload, payload?.subject, payload?.item, payload?.data].filter(Boolean);
  const values: unknown[] = [];

  for (const root of roots) {
    values.push(
      root?.pic?.large,
      root?.pic?.normal,
      root?.pic?.medium,
      root?.pic?.small,
      root?.pic,
      root?.cover_url,
      root?.cover,
      root?.poster,
      root?.poster_url,
      root?.image,
      root?.images?.large,
      root?.images?.normal,
      root?.images?.medium,
    );
  }

  for (const value of values) {
    const url = doubanImageUrl(value);
    if (url) return url;
  }
  return null;
}

function attribute(tag: string, name: string): string {
  const expression = new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  return tag.match(expression)?.[2] || '';
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
}

function posterFromHtml(html: string): URL | null {
  const tags = html.match(/<(?:meta|link)\b[^>]*>/gi) || [];
  const preferred: string[] = [];

  for (const tag of tags) {
    const property = attribute(tag, 'property').toLowerCase();
    const name = attribute(tag, 'name').toLowerCase();
    const itemprop = attribute(tag, 'itemprop').toLowerCase();
    const rel = attribute(tag, 'rel').toLowerCase();
    if (property === 'og:image' || name === 'og:image' || itemprop === 'image' || rel.includes('image_src')) {
      preferred.push(attribute(tag, 'content') || attribute(tag, 'href'));
    }
  }

  const mainPic = html.match(/<div\b[^>]*id=["']mainpic["'][\s\S]{0,3000}?<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i)?.[1];
  if (mainPic) preferred.push(mainPic);

  const jsonImages = html.match(/"image"\s*:\s*(?:\[\s*)?"((?:\\.|[^"\\])+)"/gi) || [];
  for (const entry of jsonImages) {
    const value = entry.match(/"((?:\\.|[^"\\])+)"\s*$/)?.[1];
    if (value) preferred.push(value);
  }

  for (const value of preferred) {
    const url = doubanImageUrl(decodeHtml(value));
    if (url) return url;
  }
  return null;
}

async function lookupPosterEndpoint(url: URL, accept: string, referer: string): Promise<URL | null> {
  const metadata = await fetchMetadata(url, accept, referer);
  if (!metadata) return null;

  if (/json/i.test(metadata.contentType) || /^[\s\n\r]*[\[{]/.test(metadata.text)) {
    try {
      const fromJson = posterFromJson(JSON.parse(metadata.text));
      if (fromJson) return fromJson;
    } catch {
      // Some Douban endpoints can respond with HTML despite a JSON-like content type.
    }
  }

  return posterFromHtml(metadata.text);
}

async function currentDoubanPoster(
  cache: Cache,
  origin: string,
  doubanId: string,
  mediaType: string,
  bypassCache: boolean,
): Promise<URL | null> {
  if (!NUMERIC_ID.test(doubanId)) return null;

  const kind = mediaType === 'movie' ? 'movie' : mediaType === 'tv' ? 'tv' : '';
  const cacheUrl = new URL('/__cactus/douban-poster', origin);
  cacheUrl.searchParams.set('id', doubanId);
  cacheUrl.searchParams.set('kind', kind || 'unknown');
  cacheUrl.searchParams.set('rev', POSTER_LOOKUP_REVISION);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  if (!bypassCache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const value = await cached.text();
      return doubanImageUrl(value);
    }
  }

  const kinds = kind ? [kind, kind === 'movie' ? 'tv' : 'movie'] : ['tv', 'movie'];
  let poster: URL | null = null;

  for (const candidateKind of kinds) {
    const endpoint = new URL(`https://m.douban.com/rexxar/api/v2/${candidateKind}/${doubanId}`);
    endpoint.searchParams.set('ck', '');
    endpoint.searchParams.set('for_mobile', '1');
    poster = await lookupPosterEndpoint(
      endpoint,
      'application/json, text/plain, */*',
      `https://m.douban.com/movie/subject/${doubanId}/`,
    );
    if (poster) break;
  }

  if (!poster) {
    poster = await lookupPosterEndpoint(
      new URL(`https://movie.douban.com/subject/${doubanId}/`),
      'text/html,application/xhtml+xml',
      'https://movie.douban.com/',
    );
  }

  const lookupResponse = new Response(poster?.toString() || '', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': poster
        ? 'public, max-age=600, s-maxage=600'
        : 'public, max-age=120, s-maxage=120',
    },
  });
  await cache.put(cacheKey, lookupResponse);
  return poster;
}

function mergeCandidates(...groups: URL[][]): URL[] {
  const output: URL[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const candidate of group) addCandidate(output, seen, candidate);
  }
  return output;
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const requestUrl = new URL(request.url);
  const source = requestUrl.searchParams.get('url') || '';
  const rawId = requestUrl.searchParams.get('id') || '';
  const doubanId = NUMERIC_ID.test(rawId) ? rawId : '';
  const mediaType = requestUrl.searchParams.get('kind') || '';
  const bypassCache = requestUrl.searchParams.has('retry') || requestUrl.searchParams.get('bypass') === '1';

  const sourceUrl = doubanImageUrl(source);
  if (!sourceUrl) return noStore('Bad or disallowed image URL', 400);

  const cache = caches.default;
  const officialPoster = doubanId
    ? await currentDoubanPoster(cache, requestUrl.origin, doubanId, mediaType, bypassCache)
    : null;

  const targetUrl = officialPoster || sourceUrl;
  const imageCacheUrl = new URL('/__cactus/douban-image', requestUrl.origin);
  imageCacheUrl.searchParams.set('url', targetUrl.toString());
  imageCacheUrl.searchParams.set('rev', CACHE_REVISION);
  const imageCacheKey = new Request(imageCacheUrl.toString(), { method: 'GET' });

  if (!bypassCache) {
    const cached = await cache.match(imageCacheKey);
    if (cached) return cached;
  }

  const officialCandidates = officialPoster ? imageCandidates(officialPoster) : [];
  const sourceCandidates = imageCandidates(sourceUrl);
  const candidates = mergeCandidates(officialCandidates, sourceCandidates);
  const result = await firstVerifiedImage(candidates);
  if (!result) return noStore('Douban image unavailable', 502);

  const sourceName = officialPoster && result.url.toString() !== sourceUrl.toString()
    ? 'douban-subject'
    : 'douban-list';
  const headers = new Headers();
  headers.set('content-type', result.type);
  headers.set('content-length', String(result.body.byteLength));
  headers.set('cache-control', 'public, max-age=600, s-maxage=86400, stale-while-revalidate=3600');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-cactus-poster-source', sourceName);

  const proxied = new Response(result.body, { status: 200, headers });
  await cache.put(imageCacheKey, proxied.clone());
  return proxied;
};
