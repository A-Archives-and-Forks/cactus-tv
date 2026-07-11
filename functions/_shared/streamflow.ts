import { getSetting, setSetting } from './db';
import { HttpError } from './http';
import { fetchWithTimeout } from './providers';
import type { Env, Provider } from './types';

export const STREAMFLOW_OVERLAP_SECONDS = 18;
export const STREAMFLOW_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const STREAMFLOW_HINT_TTL_SECONDS = 24 * 60 * 60;
export const STREAMFLOW_MAX_PREFETCH_OBJECTS = 6;
export const STREAMFLOW_MIN_AHEAD_SECONDS = 600;
export const STREAMFLOW_STATUS_TTL_SECONDS = 24 * 60 * 60;

const GENERATION_SETTING = 'streamflow_cache_generation';
const MAX_PLAYLIST_BYTES = 3_000_000;
const MAX_PREFETCH_OBJECT_BYTES = 48 * 1024 * 1024;

type ByteRange = { start: number; length: number };
type PlannedObject = {
  url: string;
  objectId: string;
  range?: ByteRange;
  kind: 'segment' | 'map' | 'key';
};

type PlannedSegment = {
  start: number;
  end: number;
  object: PlannedObject;
  map?: PlannedObject;
  key?: PlannedObject;
};

type StreamflowHint = {
  provider: string;
  playlistUrl: string;
  trackId: string;
};

export type StreamflowPrefetchStatus = {
  engine: 'cache-api';
  state: 'idle' | 'running' | 'partial' | 'ready' | 'error';
  phase: string;
  trackId: string;
  position: number;
  duration: number;
  targetStart: number;
  targetEnd: number;
  targetAheadSeconds: number;
  cachedThrough: number;
  cachedAheadSeconds: number;
  complete: boolean;
  batches: number;
  segmentsReady: number;
  lastBatchStored: number;
  lastBatchHits: number;
  lastBatchSkipped: number;
  totalStored: number;
  totalHits: number;
  totalSkipped: number;
  updatedAt: number;
  lastError: string;
};

export type StreamflowPrefetchInput = {
  origin: string;
  sessionId: string;
  generation: number;
  provider: Provider;
  sourceUrl: string;
  position: number;
  duration: number;
  phase: string;
  allowUnlisted: boolean;
};

function allowedHosts(provider: Provider): Set<string> {
  return new Set([
    new URL(provider.baseUrl).hostname.toLowerCase(),
    ...provider.mediaHosts.map(host => host.toLowerCase()),
  ]);
}

export function providerAllowsUrl(provider: Provider, raw: string, allowUnlisted = false): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, '缓存源地址无效', 'STREAMFLOW_INVALID_SOURCE'); }
  if (url.protocol !== 'https:') throw new HttpError(400, '缓存仅支持 HTTPS 片源', 'STREAMFLOW_HTTPS_REQUIRED');
  if (!allowUnlisted && !allowedHosts(provider).has(url.hostname.toLowerCase())) {
    throw new HttpError(403, `媒体主机 ${url.hostname} 不在数据源白名单中`, 'STREAMFLOW_HOST_BLOCKED');
  }
  url.hash = '';
  return url;
}

export function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function cacheWindow(position: number, duration: number): { eligible: boolean; start: number; end: number } {
  // The rolling window is a playback buffer, so it starts as soon as a finite
  // duration is available. The old one-third threshold only made sense for
  // long-lived R2 storage and would hide the benefit during normal playback.
  if (!(duration > 0) || position >= duration - 5) {
    return { eligible: false, start: 0, end: 0 };
  }
  const start = Math.max(0, position - STREAMFLOW_OVERLAP_SECONDS);
  const remaining = Math.max(0, duration - position);
  // Keep a fixed rolling window. The previous remaining/2 rule could trigger
  // an hour of background downloads on long films and compete with playback.
  const desiredAhead = Math.min(STREAMFLOW_MIN_AHEAD_SECONDS, remaining);
  const end = Math.min(duration, position + desiredAhead);
  return { eligible: end > start + 5, start, end };
}

export function streamflowReady(): boolean {
  return typeof caches !== 'undefined' && Boolean(caches.default);
}

export function validStreamflowId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function validObjectId(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(value);
}

export function normalizeStreamflowGeneration(value: unknown): number {
  const parsed = Math.floor(finiteNumber(value, 1));
  return parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : 1;
}

export async function getStreamflowGeneration(env: Env): Promise<number> {
  return normalizeStreamflowGeneration(await getSetting(env, GENERATION_SETTING, '1'));
}

export async function bumpStreamflowGeneration(env: Env): Promise<number> {
  if (!env.DB) throw new HttpError(503, '重置边缘缓存需要现有 D1 绑定', 'STREAMFLOW_DB_REQUIRED');
  const next = Date.now();
  await setSetting(env, GENERATION_SETTING, String(next));
  return next;
}

function rangeToken(range: string): string {
  if (!range) return 'full';
  return range.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80) || 'range';
}

export function streamflowObjectCacheRequest(
  origin: string,
  sessionId: string,
  objectId: string,
  generation: number,
  range = '',
): Request {
  if (!validStreamflowId(sessionId) || !validObjectId(objectId)) {
    throw new HttpError(400, 'CactusStreamflow 缓存标识无效', 'STREAMFLOW_INVALID_KEY');
  }
  const url = new URL(`/__cactus_streamflow_cache/v${normalizeStreamflowGeneration(generation)}/${sessionId}/${encodeURIComponent(objectId)}/${rangeToken(range)}`, origin);
  return new Request(url.toString(), { method: 'GET' });
}

export function streamflowHintCacheRequest(origin: string, sessionId: string, generation: number): Request {
  if (!validStreamflowId(sessionId)) throw new HttpError(400, '缓存会话 ID 无效', 'STREAMFLOW_INVALID_ID');
  const url = new URL(`/__cactus_streamflow_hint/v${normalizeStreamflowGeneration(generation)}/${sessionId}`, origin);
  return new Request(url.toString(), { method: 'GET' });
}


export function streamflowStatusCacheRequest(origin: string, sessionId: string, generation: number): Request {
  if (!validStreamflowId(sessionId)) throw new HttpError(400, '缓存会话 ID 无效', 'STREAMFLOW_INVALID_ID');
  const url = new URL(`/__cactus_streamflow_status/v${normalizeStreamflowGeneration(generation)}/${sessionId}`, origin);
  return new Request(url.toString(), { method: 'GET' });
}

export async function readStreamflowStatus(
  origin: string,
  sessionId: string,
  generation: number,
): Promise<StreamflowPrefetchStatus | null> {
  if (!streamflowReady() || !validStreamflowId(sessionId)) return null;
  const response = await caches.default.match(streamflowStatusCacheRequest(origin, sessionId, generation));
  if (!response) return null;
  try {
    const status = await response.json<StreamflowPrefetchStatus>();
    return status?.engine === 'cache-api' ? status : null;
  } catch { return null; }
}

async function writeStreamflowStatus(
  origin: string,
  sessionId: string,
  generation: number,
  status: StreamflowPrefetchStatus,
): Promise<void> {
  if (!streamflowReady() || !validStreamflowId(sessionId)) return;
  const response = new Response(JSON.stringify(status), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${STREAMFLOW_STATUS_TTL_SECONDS}`,
    },
  });
  await caches.default.put(streamflowStatusCacheRequest(origin, sessionId, generation), response);
}

export async function markStreamflowError(
  origin: string,
  sessionId: string,
  generation: number,
  error: unknown,
): Promise<void> {
  const previous = await readStreamflowStatus(origin, sessionId, generation);
  const message = error instanceof Error ? error.message : String(error || '预取失败');
  const now = Date.now();
  await writeStreamflowStatus(origin, sessionId, generation, {
    engine: 'cache-api',
    state: 'error',
    phase: previous?.phase || 'playing',
    trackId: previous?.trackId || 'main',
    position: previous?.position || 0,
    duration: previous?.duration || 0,
    targetStart: previous?.targetStart || 0,
    targetEnd: previous?.targetEnd || 0,
    targetAheadSeconds: previous?.targetAheadSeconds || 0,
    cachedThrough: previous?.cachedThrough || 0,
    cachedAheadSeconds: previous?.cachedAheadSeconds || 0,
    complete: false,
    batches: previous?.batches || 0,
    segmentsReady: previous?.segmentsReady || 0,
    lastBatchStored: 0,
    lastBatchHits: 0,
    lastBatchSkipped: 1,
    totalStored: previous?.totalStored || 0,
    totalHits: previous?.totalHits || 0,
    totalSkipped: (previous?.totalSkipped || 0) + 1,
    updatedAt: now,
    lastError: message.slice(0, 300),
  });
}

function cleanCachedHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  result.delete('set-cookie');
  result.delete('vary');
  result.delete('content-range');
  result.delete('transfer-encoding');
  result.set('access-control-allow-origin', '*');
  result.set('x-content-type-options', 'nosniff');
  return result;
}

export function cacheableStreamflowResponse(response: Response, objectId: string): Response {
  const headers = cleanCachedHeaders(response.headers);
  const contentRange = response.headers.get('content-range') || '';
  const ttl = objectId.includes('--key-') ? 6 * 60 * 60 : STREAMFLOW_CACHE_TTL_SECONDS;
  headers.set('cache-control', `public, max-age=${ttl}, immutable`);
  headers.set('x-cactus-upstream-status', String(response.status));
  if (contentRange) headers.set('x-cactus-content-range', contentRange);
  return new Response(response.body, { status: 200, headers });
}

export async function matchStreamflowObject(
  origin: string,
  sessionId: string,
  objectId: string,
  generation: number,
  range = '',
): Promise<Response | null> {
  if (!streamflowReady() || !validStreamflowId(sessionId) || !validObjectId(objectId)) return null;
  const cached = await caches.default.match(streamflowObjectCacheRequest(origin, sessionId, objectId, generation, range));
  if (!cached) return null;
  const headers = cleanCachedHeaders(cached.headers);
  const upstreamStatus = Number(cached.headers.get('x-cactus-upstream-status') || 200);
  const contentRange = cached.headers.get('x-cactus-content-range') || '';
  headers.delete('x-cactus-upstream-status');
  headers.delete('x-cactus-content-range');
  headers.set('x-cactus-streamflow', 'HIT');
  headers.set('cache-control', 'private, max-age=60');
  if (contentRange) headers.set('content-range', contentRange);
  if (upstreamStatus === 206 || contentRange) headers.set('accept-ranges', 'bytes');
  return new Response(cached.body, { status: upstreamStatus === 206 || contentRange ? 206 : 200, headers });
}

export async function storeStreamflowObject(
  origin: string,
  sessionId: string,
  objectId: string,
  generation: number,
  range: string,
  response: Response,
): Promise<void> {
  if (!streamflowReady() || !response.ok || !validStreamflowId(sessionId) || !validObjectId(objectId)) return;
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PREFETCH_OBJECT_BYTES) return;
  const key = streamflowObjectCacheRequest(origin, sessionId, objectId, generation, range);
  await caches.default.put(key, cacheableStreamflowResponse(response, objectId));
}

export async function rememberStreamflowHint(
  origin: string,
  sessionId: string,
  generation: number,
  hint: StreamflowHint,
): Promise<void> {
  if (!streamflowReady() || !validStreamflowId(sessionId)) return;
  const response = new Response(JSON.stringify(hint), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${STREAMFLOW_HINT_TTL_SECONDS}`,
    },
  });
  await caches.default.put(streamflowHintCacheRequest(origin, sessionId, generation), response);
}

async function readStreamflowHint(origin: string, sessionId: string, generation: number): Promise<StreamflowHint | null> {
  if (!streamflowReady()) return null;
  const response = await caches.default.match(streamflowHintCacheRequest(origin, sessionId, generation));
  if (!response) return null;
  try {
    const hint = await response.json<StreamflowHint>();
    if (!hint?.playlistUrl || !hint?.trackId || !hint?.provider) return null;
    return hint;
  } catch { return null; }
}

async function fetchAllowed(provider: Provider, rawUrl: string, range = '', maxAttempts = 4, allowUnlisted = false): Promise<Response> {
  let current = providerAllowsUrl(provider, rawUrl, allowUnlisted);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const headers = new Headers({ Accept: '*/*', 'User-Agent': 'CactusTV/0.8.4', ...provider.requestHeaders });
    if (range) headers.set('range', range);
    const response = await fetchWithTimeout(current.toString(), { headers, redirect: 'manual' }, 14_000);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = providerAllowsUrl(provider, new URL(location, current).toString(), allowUnlisted);
  }
  throw new HttpError(502, '媒体地址重定向次数过多', 'TOO_MANY_REDIRECTS');
}

async function fetchPlaylist(provider: Provider, rawUrl: string, allowUnlisted = false): Promise<{ text: string; url: URL }> {
  const response = await fetchAllowed(provider, rawUrl, '', 2, allowUnlisted);
  if (!response.ok) throw new HttpError(502, `播放列表上游返回 HTTP ${response.status}`, 'STREAMFLOW_PLAYLIST_ERROR');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PLAYLIST_BYTES) throw new HttpError(502, '播放列表过大', 'PLAYLIST_TOO_LARGE');
  const text = await response.text();
  if (text.length > MAX_PLAYLIST_BYTES || !text.trimStart().startsWith('#EXTM3U')) {
    throw new HttpError(415, 'CactusStreamflow 目前只预取 HLS 点播', 'STREAMFLOW_HLS_REQUIRED');
  }
  const finalUrl = response.url
    ? providerAllowsUrl(provider, response.url, allowUnlisted)
    : providerAllowsUrl(provider, rawUrl, allowUnlisted);
  return { text, url: finalUrl };
}

function parseAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input))) {
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    result[match[1].toUpperCase()] = value;
  }
  return result;
}

function parseByteRange(value: string): { length: number; offset?: number } | null {
  const match = String(value || '').trim().match(/^(\d+)(?:@(\d+))?$/);
  if (!match) return null;
  const length = Number(match[1]);
  const offset = match[2] == null ? undefined : Number(match[2]);
  if (!(length > 0) || (offset != null && offset < 0)) return null;
  return { length, offset };
}

function rangeSuffix(range?: ByteRange): string {
  return range ? `-br-${range.start}-${range.length}` : '';
}

function rangeHeader(range?: ByteRange): string {
  return range ? `bytes=${range.start}-${range.start + range.length - 1}` : '';
}

function chooseVariant(text: string, base: URL): { url: string; trackId: string } | null {
  const lines = text.split(/\r?\n/);
  const variants: Array<{ url: string; trackId: string; height: number; bandwidth: number }> = [];
  let pending: Record<string, string> | null = null;
  let index = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice(line.indexOf(':') + 1));
      continue;
    }
    if (!pending || !line || line.startsWith('#')) continue;
    try {
      const resolution = String(pending.RESOLUTION || '').split('x');
      variants.push({
        url: new URL(line, base).toString(),
        trackId: `v${index}`,
        height: Number(resolution[1] || 0),
        bandwidth: Number(pending.BANDWIDTH || pending['AVERAGE-BANDWIDTH'] || 0),
      });
      index += 1;
    } catch {}
    pending = null;
  }
  if (!variants.length) return null;
  const sensible = variants.filter(item => !item.height || item.height <= 1080);
  return (sensible.length ? sensible : variants)
    .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
}

function parseMediaPlaylist(text: string, base: URL, trackId: string): PlannedSegment[] {
  const lines = text.split(/\r?\n/);
  const previousRangeEnd = new Map<string, number>();
  let mediaSequence = 0;
  let segmentIndex = 0;
  let mapIndex = 0;
  let keyIndex = 0;
  let pendingDuration = 0;
  let pendingRange: { length: number; offset?: number } | null = null;
  let currentTime = 0;
  let currentMap: PlannedObject | undefined;
  let currentKey: PlannedObject | undefined;
  const segments: PlannedSegment[] = [];

  const materializeRange = (absolute: string, raw: { length: number; offset?: number } | null): ByteRange | undefined => {
    if (!raw) return undefined;
    const start = raw.offset == null ? (previousRangeEnd.get(absolute) || 0) : raw.offset;
    previousRangeEnd.set(absolute, start + raw.length);
    return { start, length: raw.length };
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Math.max(0, Number(line.slice(line.indexOf(':') + 1)) || 0);
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Math.max(0, Number(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0);
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(line.indexOf(':') + 1));
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (!attrs.URI) continue;
      try {
        const absolute = new URL(attrs.URI, base).toString();
        const range = materializeRange(absolute, parseByteRange(attrs.BYTERANGE || ''));
        currentMap = { url: absolute, objectId: `${trackId}--map-${mapIndex++}${rangeSuffix(range)}`, range, kind: 'map' };
      } catch {}
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (String(attrs.METHOD || '').toUpperCase() === 'NONE' || !attrs.URI) {
        currentKey = undefined;
      } else {
        try {
          currentKey = { url: new URL(attrs.URI, base).toString(), objectId: `${trackId}--key-${keyIndex++}`, kind: 'key' };
        } catch { currentKey = undefined; }
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    try {
      const absolute = new URL(line, base).toString();
      const range = materializeRange(absolute, pendingRange);
      const duration = pendingDuration > 0 ? pendingDuration : 6;
      const start = currentTime;
      const end = start + duration;
      segments.push({
        start,
        end,
        object: {
          url: absolute,
          objectId: `${trackId}--seg-${mediaSequence + segmentIndex}${rangeSuffix(range)}`,
          range,
          kind: 'segment',
        },
        map: currentMap,
        key: currentKey,
      });
      currentTime = end;
      segmentIndex += 1;
      pendingDuration = 0;
      pendingRange = null;
    } catch {}
  }
  return segments;
}

function prefetchLimit(phase: string): number {
  if (phase === 'paused') return STREAMFLOW_MAX_PREFETCH_OBJECTS;
  if (phase === 'playing') return 4;
  return 0;
}

async function cachePlannedObject(input: StreamflowPrefetchInput, object: PlannedObject): Promise<'hit' | 'stored' | 'skipped'> {
  const range = rangeHeader(object.range);
  const key = streamflowObjectCacheRequest(input.origin, input.sessionId, object.objectId, input.generation, range);
  if (await caches.default.match(key)) return 'hit';
  const response = await fetchAllowed(input.provider, object.url, range, 2, input.allowUnlisted);
  if (!response.ok && response.status !== 206) return 'skipped';
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PREFETCH_OBJECT_BYTES) {
    try { await response.body?.cancel(); } catch {}
    return 'skipped';
  }
  await caches.default.put(key, cacheableStreamflowResponse(response, object.objectId));
  return 'stored';
}

function emptyStatus(input: StreamflowPrefetchInput, window: { start: number; end: number }, previous: StreamflowPrefetchStatus | null): StreamflowPrefetchStatus {
  const cachedThrough = Math.max(window.start, previous?.cachedThrough || window.start);
  return {
    engine: 'cache-api',
    state: 'running',
    phase: input.phase,
    trackId: previous?.trackId || 'main',
    position: input.position,
    duration: input.duration,
    targetStart: window.start,
    targetEnd: window.end,
    targetAheadSeconds: Math.max(0, window.end - input.position),
    cachedThrough,
    cachedAheadSeconds: Math.max(0, cachedThrough - input.position),
    complete: false,
    batches: previous?.batches || 0,
    segmentsReady: previous?.segmentsReady || 0,
    lastBatchStored: 0,
    lastBatchHits: 0,
    lastBatchSkipped: 0,
    totalStored: previous?.totalStored || 0,
    totalHits: previous?.totalHits || 0,
    totalSkipped: previous?.totalSkipped || 0,
    updatedAt: Date.now(),
    lastError: '',
  };
}

export async function prefetchStreamflow(input: StreamflowPrefetchInput): Promise<StreamflowPrefetchStatus | null> {
  if (!streamflowReady() || !validStreamflowId(input.sessionId)) return null;
  const window = cacheWindow(input.position, input.duration);
  if (!window.eligible) return null;

  const previous = await readStreamflowStatus(input.origin, input.sessionId, input.generation);
  let status = emptyStatus(input, window, previous);
  await writeStreamflowStatus(input.origin, input.sessionId, input.generation, status);

  const hint = await readStreamflowHint(input.origin, input.sessionId, input.generation);
  let playlistUrl = hint?.provider === input.provider.id ? hint.playlistUrl : input.sourceUrl;
  let trackId = hint?.provider === input.provider.id ? hint.trackId : 'main';
  let playlist = await fetchPlaylist(input.provider, playlistUrl, input.allowUnlisted);

  const variant = chooseVariant(playlist.text, playlist.url);
  if (variant) {
    playlistUrl = variant.url;
    trackId = variant.trackId;
    playlist = await fetchPlaylist(input.provider, playlistUrl, input.allowUnlisted);
  }

  const allSegments = parseMediaPlaylist(playlist.text, playlist.url, trackId)
    .filter(segment => segment.end >= window.start && segment.start <= window.end);
  if (!allSegments.length) {
    status = { ...status, state: 'error', trackId, updatedAt: Date.now(), lastError: '播放列表中没有可预取的 HLS 分片' };
    await writeStreamflowStatus(input.origin, input.sessionId, input.generation, status);
    return status;
  }

  const targetEnd = Math.min(window.end, allSegments[allSegments.length - 1].end);

  // A seek backwards or a rendition change resets the cursor to the new playback window.
  const movedBack = previous && input.position + 90 < previous.position;
  const trackChanged = previous && previous.trackId && previous.trackId !== trackId;
  let cursor = Math.max(window.start, previous?.cachedThrough || window.start);
  if (movedBack || trackChanged || cursor > targetEnd + 5) cursor = window.start;

  const segmentStartIndex = allSegments.findIndex(segment => segment.end > cursor + 0.05);
  const candidates = segmentStartIndex >= 0 ? allSegments.slice(segmentStartIndex) : [];
  const objectBudget = prefetchLimit(input.phase);
  const seen = new Set<string>();
  let objectCalls = 0;
  let stored = 0;
  let hits = 0;
  let skipped = 0;
  let readySegments = 0;
  let cachedThrough = cursor;

  for (const segment of candidates) {
    const required = [segment.map, segment.key, segment.object]
      .filter((object): object is PlannedObject => Boolean(object && !seen.has(object.objectId)));
    if (!required.length) {
      cachedThrough = Math.max(cachedThrough, segment.end);
      readySegments += 1;
      continue;
    }
    if (objectCalls + required.length > objectBudget) break;
    required.forEach(object => seen.add(object.objectId));
    objectCalls += required.length;

    const results = await Promise.allSettled(required.map(object => cachePlannedObject(input, object)));
    let segmentReady = true;
    for (const result of results) {
      if (result.status === 'rejected') {
        skipped += 1;
        segmentReady = false;
      } else if (result.value === 'stored') stored += 1;
      else if (result.value === 'hit') hits += 1;
      else {
        skipped += 1;
        segmentReady = false;
      }
    }
    if (!segmentReady) break;
    cachedThrough = Math.max(cachedThrough, segment.end);
    readySegments += 1;
    if (cachedThrough >= targetEnd - 0.25) break;
  }

  const complete = cachedThrough >= targetEnd - 0.25;
  status = {
    ...status,
    state: complete ? 'ready' : 'partial',
    phase: input.phase,
    trackId,
    position: input.position,
    duration: input.duration,
    targetStart: window.start,
    targetEnd,
    targetAheadSeconds: Math.max(0, targetEnd - input.position),
    cachedThrough,
    cachedAheadSeconds: Math.max(0, cachedThrough - input.position),
    complete,
    batches: (previous?.batches || 0) + 1,
    segmentsReady: (movedBack || trackChanged ? 0 : previous?.segmentsReady || 0) + readySegments,
    lastBatchStored: stored,
    lastBatchHits: hits,
    lastBatchSkipped: skipped,
    totalStored: (movedBack || trackChanged ? 0 : previous?.totalStored || 0) + stored,
    totalHits: (movedBack || trackChanged ? 0 : previous?.totalHits || 0) + hits,
    totalSkipped: (movedBack || trackChanged ? 0 : previous?.totalSkipped || 0) + skipped,
    updatedAt: Date.now(),
    lastError: skipped ? '部分分片暂时无法缓存，将在下一批重试' : '',
  };
  await writeStreamflowStatus(input.origin, input.sessionId, input.generation, status);
  return status;
}
