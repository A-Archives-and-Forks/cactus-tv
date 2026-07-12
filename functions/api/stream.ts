import { HttpError, ok } from '../_shared/http';
import { fetchWithTimeout, findProvider, validateHttpsUrl } from '../_shared/providers';
import type { AppData, Env, Provider } from '../_shared/types';

const PLAYLIST_LIMIT = 3_000_000;
const SNIFF_LIMIT = 64 * 1024;
const STRONG_AD_TOKEN = /(?:^|[\/_\-.?&=])(?:ads?|advert(?:isement)?s?|commercials?|promo(?:tion)?s?|pre-?roll|mid-?roll|post-?roll|casino|bet(?:ting)?|gambling|博彩|赌博)(?:[\/_\-.?&=]|$)/i;
const AD_TEXT_TOKEN = /(?:广告|博彩|赌博|casino|gambling|advert(?:isement)?|commercial|pre-?roll|mid-?roll|post-?roll)/i;
const AD_CUE_OUT = /^#EXT-X-(?:CUE-OUT(?:-CONT)?|SCTE35|OATCLS-SCTE35)\b/i;
const AD_CUE_IN = /^#EXT-X-CUE-IN\b/i;

function hostMatchesRule(hostname: string, rule: string): boolean {
  const host = hostname.toLowerCase();
  const normalized = rule.trim().toLowerCase();
  if (!normalized) return false;
  if (!normalized.startsWith('*.')) return host === normalized;
  const base = normalized.slice(2);
  if (base.split('.').length < 2) return false;
  return host !== base && host.endsWith(`.${base}`);
}

function allowedHost(provider: Provider, hostname: string): boolean {
  const rules = [new URL(provider.baseUrl).hostname.toLowerCase(), ...provider.mediaHosts];
  return rules.some(rule => hostMatchesRule(hostname, rule));
}

function assertMediaUrl(provider: Provider, raw: string): URL {
  const value = validateHttpsUrl(raw);
  const url = new URL(value);
  if (!allowedHost(provider, url.hostname)) throw new HttpError(403, `媒体主机 ${url.hostname} 不在该数据源白名单中`, 'MEDIA_HOST_BLOCKED');
  return url;
}

function proxied(provider: Provider, absolute: string, clean = false): string {
  const params = new URLSearchParams({ provider: provider.id, url: absolute });
  if (clean) params.set('clean', '1');
  return `/api/stream?${params.toString()}`;
}

function isAdDateRange(line: string): boolean {
  if (!/^#EXT-X-DATERANGE:/i.test(line)) return false;
  return /(?:CLASS|ID)="[^"]*(?:ad|advert|commercial|interstitial|scte)[^"]*"/i.test(line)
    || /SCTE35-(?:OUT|CMD)=/i.test(line)
    || /X-ASSET-URI=/i.test(line);
}

function hasImplicitAesIv(text: string): boolean {
  return text.split(/\r?\n/).some(line => /^#EXT-X-KEY:/i.test(line)
    && /METHOD=AES-128/i.test(line)
    && !/\bIV=0x[0-9a-f]+/i.test(line));
}

function rewriteMediaSequence(lines: string[], leadingRemoved: number): string[] {
  if (!leadingRemoved) return lines;
  return lines.map(line => line.replace(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/i, (_all, raw) => `#EXT-X-MEDIA-SEQUENCE:${Number(raw) + leadingRemoved}`));
}

function cleanHlsPlaylist(text: string): { text: string; removed: number; applied: boolean; reason: string } {
  if (!/#EXTINF:/i.test(text)) return { text, removed: 0, applied: false, reason: 'master-playlist' };
  if (hasImplicitAesIv(text)) return { text, removed: 0, applied: false, reason: 'implicit-aes-iv' };
  // Segment deletion is unsafe when the source already carries explicit timeline
  // boundaries or byte-range/fMP4 state. Removing one of those boundaries can
  // expose the MPEG-TS 33-bit timestamp wrap (~26.5h) to MSE and corrupt seeking.
  if (/#EXT-X-(?:DISCONTINUITY(?:-SEQUENCE)?|MAP|BYTERANGE|PROGRAM-DATE-TIME)\b/i.test(text)) {
    return { text, removed: 0, applied: false, reason: 'timeline-sensitive' };
  }

  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let pending: string[] = [];
  let cueActive = false;
  let cueWasExplicit = false;
  let totalSegments = 0;
  let removedSegments = 0;
  let removedMarkers = 0;
  let keptSegments = 0;
  let leadingRemoved = 0;
  let sawKeptSegment = false;
  let insertDiscontinuity = false;

  const flushNonSegmentPending = () => {
    if (!pending.length) return;
    output.push(...pending);
    pending = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (AD_CUE_OUT.test(line)) {
      cueActive = true;
      cueWasExplicit = true;
      removedMarkers += 1;
      insertDiscontinuity = sawKeptSegment;
      continue;
    }
    if (isAdDateRange(line)) {
      // HLS interstitial signaling can be removed without deleting the main media timeline.
      cueWasExplicit = true;
      removedMarkers += 1;
      continue;
    }
    if (AD_CUE_IN.test(line)) {
      cueActive = false;
      removedMarkers += 1;
      insertDiscontinuity = sawKeptSegment;
      continue;
    }

    if (/^#EXTINF:/i.test(line)) {
      flushNonSegmentPending();
      pending = [rawLine];
      continue;
    }

    if (pending.length) {
      if (!line || line.startsWith('#')) {
        pending.push(rawLine);
        continue;
      }

      totalSegments += 1;
      const metadata = pending.join('\n');
      const adByKeyword = STRONG_AD_TOKEN.test(line);
      const shouldRemove = cueActive || adByKeyword;

      if (shouldRemove) {
        removedSegments += 1;
        if (!sawKeptSegment) leadingRemoved += 1;
        else insertDiscontinuity = true;
        pending = [];
        continue;
      }

      if (insertDiscontinuity && sawKeptSegment && !pending.some(item => /^#EXT-X-DISCONTINUITY\b/i.test(item.trim()))) {
        output.push('#EXT-X-DISCONTINUITY');
      }
      output.push(...pending, rawLine);
      pending = [];
      insertDiscontinuity = false;
      keptSegments += 1;
      sawKeptSegment = true;
      continue;
    }

    // Remove ad signaling tags, while keeping normal HLS metadata untouched.
    if (AD_CUE_OUT.test(line) || AD_CUE_IN.test(line) || isAdDateRange(line)) continue;
    output.push(rawLine);
  }

  flushNonSegmentPending();
  if (!removedSegments && removedMarkers) {
    return { text: output.join('\n'), removed: 0, applied: true, reason: 'interstitial-marker' };
  }
  if (!removedSegments || totalSegments < 3 || keptSegments < 2) {
    return { text, removed: 0, applied: false, reason: removedSegments ? 'too-few-segments' : 'no-match' };
  }

  const ratio = removedSegments / Math.max(1, totalSegments);
  // Keyword matching is intentionally conservative. Explicit SCTE/CUE markers are trusted more.
  if ((!cueWasExplicit && ratio > 0.28) || ratio > 0.45) {
    return { text, removed: 0, applied: false, reason: 'safety-rollback' };
  }

  return {
    text: rewriteMediaSequence(output, leadingRemoved).join('\n'),
    removed: removedSegments,
    applied: true,
    reason: cueWasExplicit ? 'cue-marker' : 'strong-keyword',
  };
}

function rewriteM3u8(text: string, base: URL, provider: Provider, clean: boolean): { text: string; removed: number; cleanReason: string } {
  const cleaned = clean ? cleanHlsPlaylist(text) : { text, removed: 0, applied: false, reason: 'disabled' };
  const rewritten = cleaned.text.split(/\r?\n/).map(rawLine => {
    const trimmed = rawLine.trim();
    if (!trimmed) return rawLine;
    if (!trimmed.startsWith('#')) {
      try { return proxied(provider, new URL(trimmed, base).toString(), clean); }
      catch { return rawLine; }
    }
    return rawLine.replace(/URI="([^"]+)"/g, (_all, uri) => {
      try { return `URI="${proxied(provider, new URL(uri, base).toString(), clean)}"`; }
      catch { return `URI="${uri}"`; }
    });
  }).join('\n');
  return { text: rewritten, removed: cleaned.removed, cleanReason: cleaned.reason };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function normalizeMpdBase(text: string, manifestUrl: URL): string {
  const directory = new URL('.', manifestUrl).toString();
  return text.replace(/<MPD\b[^>]*>/i, match => `${match}<BaseURL>${escapeXml(directory)}</BaseURL>`);
}

async function fetchRedirectSafe(provider: Provider, url: URL, request: Request): Promise<Response> {
  let current = url;
  for (let i = 0; i < 4; i += 1) {
    assertMediaUrl(provider, current.toString());
    const headers = new Headers({ Accept: '*/*', 'User-Agent': 'CactusTV/1.3.0', ...provider.requestHeaders });
    const range = request.headers.get('range');
    if (range) headers.set('range', range);
    const response = await fetchWithTimeout(current.toString(), { headers, redirect: 'manual' }, 15_000);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current);
    assertMediaUrl(provider, current.toString());
  }
  throw new HttpError(502, '媒体地址重定向次数过多', 'TOO_MANY_REDIRECTS');
}

function declaredKind(contentType: string, url: URL): 'hls' | 'dash' | 'media' | '' {
  const path = `${url.pathname}${url.search}`;
  if (contentType.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(path)) return 'hls';
  if (contentType.includes('dash+xml') || /\.mpd(?:$|[?#])/i.test(path)) return 'dash';
  if (contentType.startsWith('video/') || contentType.startsWith('audio/')) return 'media';
  return '';
}

function sniffKind(bytes: Uint8Array): 'hls' | 'dash' | 'media' {
  const sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, SNIFF_LIMIT)).trimStart();
  if (sample.startsWith('#EXTM3U')) return 'hls';
  if (/^<\?xml[\s\S]{0,500}<MPD\b|^<MPD\b/i.test(sample)) return 'dash';
  return 'media';
}

async function readPrefix(body: ReadableStream<Uint8Array> | null, limit = SNIFF_LIMIT): Promise<{
  prefix: Uint8Array;
  rest: ReadableStream<Uint8Array> | null;
}> {
  if (!body) return { prefix: new Uint8Array(), rest: null };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total < limit) {
    const result = await reader.read();
    done = result.done;
    if (result.value) { chunks.push(result.value); total += result.value.byteLength; }
    if (done) break;
  }
  const prefix = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(chunk => { prefix.set(chunk, offset); offset += chunk.byteLength; });
  if (done) return { prefix, rest: null };
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) { controller.close(); reader.releaseLock(); }
      else controller.enqueue(result.value);
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return { prefix, rest };
}

function combinedBody(prefix: Uint8Array, rest: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> {
  let sent = false;
  const reader = rest?.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        if (prefix.byteLength) controller.enqueue(prefix);
        if (!reader) controller.close();
        return;
      }
      if (!reader) { controller.close(); return; }
      const result = await reader.read();
      if (result.done) { controller.close(); reader.releaseLock(); }
      else controller.enqueue(result.value);
    },
    async cancel(reason) { await reader?.cancel(reason); },
  });
}

function mediaHeaders(upstream: Response, contentType: string): Headers {
  const headers = new Headers();
  ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(key => {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  });
  headers.set('cache-control', contentType.includes('video') || contentType.includes('audio') || contentType.includes('octet-stream')
    ? 'public, max-age=300, stale-while-revalidate=60'
    : 'public, max-age=60');
  headers.set('access-control-allow-origin', '*');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('vary', 'Range');
  return headers;
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  const params = new URL(request.url).searchParams;
  const provider = await findProvider(env, params.get('provider') || '');
  if (!provider || !provider.enabled || !provider.proxyEnabled) throw new HttpError(404, '该数据源未启用受控代理', 'PROXY_DISABLED');

  const clean = params.get('clean') === '1';
  const target = assertMediaUrl(provider, params.get('url') || '');
  const upstream = await fetchRedirectSafe(provider, target, request);
  if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, `媒体上游返回 HTTP ${upstream.status}`, 'MEDIA_UPSTREAM_ERROR');

  const finalUrl = upstream.url ? new URL(upstream.url) : target;
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  let kind = declaredKind(contentType, finalUrl);
  let prefix = new Uint8Array();
  let rest: ReadableStream<Uint8Array> | null = upstream.body;

  if (!kind || contentType.includes('octet-stream') || contentType.includes('text/plain')) {
    const peeked = await readPrefix(upstream.body);
    prefix = peeked.prefix;
    rest = peeked.rest;
    kind = sniffKind(prefix);
  }

  if (params.get('probe') === '1') {
    try { await rest?.cancel(); } catch {}
    return ok({ kind, contentType, finalUrl: finalUrl.toString(), clean }, 200, { 'cache-control': 'no-store, private' });
  }

  if (kind === 'hls') {
    let bytes = prefix;
    if (rest) {
      const remaining = await new Response(rest).arrayBuffer();
      if (bytes.byteLength + remaining.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, '播放列表过大', 'PLAYLIST_TOO_LARGE');
      const combined = new Uint8Array(bytes.byteLength + remaining.byteLength);
      combined.set(bytes, 0);
      combined.set(new Uint8Array(remaining), bytes.byteLength);
      bytes = combined;
    }
    if (bytes.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, '播放列表过大', 'PLAYLIST_TOO_LARGE');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const rewritten = rewriteM3u8(text, finalUrl, provider, clean);
    return new Response(rewritten.text, {
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'cache-control': 'no-store, private',
        'access-control-allow-origin': '*',
        'x-cactus-media-kind': 'hls',
        'x-cactus-cleanstream': clean ? (rewritten.removed ? 'FILTERED' : 'PASS') : 'OFF',
        'x-cactus-cleanstream-removed': String(rewritten.removed),
        'x-cactus-cleanstream-reason': rewritten.cleanReason,
      },
    });
  }

  if (kind === 'dash') {
    let bytes = prefix;
    if (rest) {
      const remaining = await new Response(rest).arrayBuffer();
      if (bytes.byteLength + remaining.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, 'DASH 清单过大', 'PLAYLIST_TOO_LARGE');
      const combined = new Uint8Array(bytes.byteLength + remaining.byteLength);
      combined.set(bytes, 0);
      combined.set(new Uint8Array(remaining), bytes.byteLength);
      bytes = combined;
    }
    if (bytes.byteLength > PLAYLIST_LIMIT) throw new HttpError(502, 'DASH 清单过大', 'PLAYLIST_TOO_LARGE');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return new Response(normalizeMpdBase(text, finalUrl), {
      headers: {
        'content-type': 'application/dash+xml; charset=utf-8',
        'cache-control': 'no-store, private',
        'access-control-allow-origin': '*',
        'x-cactus-media-kind': 'dash',
      },
    });
  }

  const allowedTypes = ['video/', 'audio/', 'application/octet-stream', 'application/dash+xml', 'text/xml', 'application/xml', 'text/plain'];
  if (contentType && !allowedTypes.some(type => contentType.includes(type))) {
    try { await rest?.cancel(); } catch {}
    throw new HttpError(415, `不支持代理该媒体类型：${contentType}`, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const headers = mediaHeaders(upstream, contentType);
  headers.set('x-cactus-media-kind', kind || 'media');
  if (!headers.get('content-type') || contentType.includes('text/plain')) headers.set('content-type', 'application/octet-stream');
  const body = prefix.byteLength ? combinedBody(prefix, rest) : rest;
  return new Response(body, { status: upstream.status, headers });
};
