import { HttpError, ok } from '../_shared/http';
import { fetchWithTimeout, findProvider, validateHttpsUrl } from '../_shared/providers';
import { ensureStreamflowSchema, streamflowObjectKey, validObjectId, validStreamflowId } from '../_shared/streamflow';
import type { AppData, Env, Provider } from '../_shared/types';

const PLAYLIST_LIMIT = 3_000_000;
const SNIFF_LIMIT = 64 * 1024;

type ByteRange = { start: number; length: number };

function allowedHost(provider: Provider, hostname: string): boolean {
  const allowed = new Set([new URL(provider.baseUrl).hostname.toLowerCase(), ...provider.mediaHosts.map(x => x.toLowerCase())]);
  return allowed.has(hostname.toLowerCase());
}

function assertMediaUrl(provider: Provider, raw: string): URL {
  const value = validateHttpsUrl(raw);
  const url = new URL(value);
  if (!allowedHost(provider, url.hostname)) throw new HttpError(403, `媒体主机 ${url.hostname} 不在该数据源白名单中`, 'MEDIA_HOST_BLOCKED');
  return url;
}

function proxied(provider: Provider, absolute: string, streamflowId = '', trackId = '', objectId = ''): string {
  const params = new URLSearchParams({ provider: provider.id, url: absolute });
  if (validStreamflowId(streamflowId)) params.set('sf', streamflowId);
  if (trackId) params.set('sft', trackId);
  if (objectId && validObjectId(objectId)) params.set('sfi', objectId);
  return `/api/stream?${params.toString()}`;
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

function rewriteUriAttribute(line: string, rewrite: (uri: string) => string): string {
  return line.replace(/URI="([^"]+)"/g, (_all, uri) => `URI="${rewrite(uri)}"`);
}

function rewriteM3u8(text: string, base: URL, provider: Provider, streamflowId = '', inheritedTrack = 'main'): string {
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some(line => line.trim().startsWith('#EXT-X-STREAM-INF:'));
  const output: string[] = [];
  const previousRangeEnd = new Map<string, number>();
  let mediaSequence = 0;
  let segmentIndex = 0;
  let variantIndex = 0;
  let audioIndex = 0;
  let otherPlaylistIndex = 0;
  let mapIndex = 0;
  let keyIndex = 0;
  let pendingVariant = false;
  let pendingRange: { length: number; offset?: number } | null = null;

  const materializeRange = (absolute: string, raw: { length: number; offset?: number } | null): ByteRange | undefined => {
    if (!raw) return undefined;
    const start = raw.offset == null ? (previousRangeEnd.get(absolute) || 0) : raw.offset;
    previousRangeEnd.set(absolute, start + raw.length);
    return { start, length: raw.length };
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) { output.push(rawLine); continue; }

    if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Math.max(0, Number(trimmed.slice(trimmed.indexOf(':') + 1)) || 0);
      output.push(rawLine);
      continue;
    }
    if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(trimmed.slice(trimmed.indexOf(':') + 1));
      output.push(rawLine);
      continue;
    }
    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = true;
      output.push(rawLine);
      continue;
    }

    if (!trimmed.startsWith('#')) {
      try {
        const absolute = new URL(trimmed, base).toString();
        if (isMaster) {
          const track = pendingVariant ? `v${variantIndex++}` : `m${otherPlaylistIndex++}`;
          output.push(proxied(provider, absolute, streamflowId, track));
          pendingVariant = false;
        } else {
          const range = materializeRange(absolute, pendingRange);
          const objectId = `${inheritedTrack}--seg-${mediaSequence + segmentIndex}${rangeSuffix(range)}`;
          output.push(proxied(provider, absolute, streamflowId, inheritedTrack, objectId));
          segmentIndex += 1;
          pendingRange = null;
        }
      } catch { output.push(rawLine); }
      continue;
    }

    if (trimmed.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(trimmed.slice(trimmed.indexOf(':') + 1));
      const type = String(attrs.TYPE || '').toUpperCase();
      if (!attrs.URI) { output.push(rawLine); continue; }
      const track = type === 'AUDIO' ? `a${audioIndex++}` : `m${otherPlaylistIndex++}`;
      output.push(rewriteUriAttribute(rawLine, uri => {
        try { return proxied(provider, new URL(uri, base).toString(), streamflowId, track); }
        catch { return uri; }
      }));
      continue;
    }

    if (!isMaster && trimmed.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(trimmed.slice(trimmed.indexOf(':') + 1));
      output.push(rewriteUriAttribute(rawLine, uri => {
        try {
          const absolute = new URL(uri, base).toString();
          const range = materializeRange(absolute, parseByteRange(attrs.BYTERANGE || ''));
          const objectId = `${inheritedTrack}--map-${mapIndex++}${rangeSuffix(range)}`;
          return proxied(provider, absolute, streamflowId, inheritedTrack, objectId);
        } catch { return uri; }
      }));
      continue;
    }

    if (!isMaster && trimmed.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(trimmed.slice(trimmed.indexOf(':') + 1));
      if (String(attrs.METHOD || '').toUpperCase() === 'NONE' || !attrs.URI) {
        output.push(rawLine);
      } else {
        const objectId = `${inheritedTrack}--key-${keyIndex++}`;
        output.push(rewriteUriAttribute(rawLine, uri => {
          try { return proxied(provider, new URL(uri, base).toString(), streamflowId, inheritedTrack, objectId); }
          catch { return uri; }
        }));
      }
      continue;
    }

    output.push(rawLine.replace(/URI="([^"]+)"/g, (_all, uri) => {
      try { return `URI="${proxied(provider, new URL(uri, base).toString(), streamflowId, inheritedTrack)}"`; }
      catch { return `URI="${uri}"`; }
    }));
  }
  return output.join('\n');
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
    const headers = new Headers({ Accept: '*/*', 'User-Agent': 'CactusTV/0.7', ...provider.requestHeaders });
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

async function streamflowHit(env: Env, sessionId: string, objectId: string): Promise<Response | null> {
  if (!env.STREAMFLOW_R2 || !validStreamflowId(sessionId) || !validObjectId(objectId)) return null;
  const object = await env.STREAMFLOW_R2.get(streamflowObjectKey(sessionId, objectId));
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-length', String(object.size));
  headers.set('etag', object.httpEtag);
  headers.set('access-control-allow-origin', '*');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-cactus-streamflow', 'HIT');
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  const range = object.customMetadata?.range || '';
  const upstreamStatus = Number(object.customMetadata?.upstreamStatus || 200);
  if (range) {
    const [startRaw, lengthRaw] = range.split(':');
    const start = Number(startRaw);
    const length = Number(lengthRaw);
    if (Number.isFinite(start) && Number.isFinite(length) && length > 0) {
      headers.set('content-range', `bytes ${start}-${start + length - 1}/*`);
      headers.set('accept-ranges', 'bytes');
    }
  }
  return new Response(object.body, { status: upstreamStatus === 206 || range ? 206 : 200, headers });
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env, waitUntil }) => {
  const requestUrl = new URL(request.url);
  const params = requestUrl.searchParams;
  const provider = await findProvider(env, params.get('provider') || '');
  if (!provider || !provider.enabled || !provider.proxyEnabled) throw new HttpError(404, '该数据源未启用受控代理', 'PROXY_DISABLED');

  const streamflowId = params.get('sf') || '';
  const objectId = params.get('sfi') || '';
  if (streamflowId && objectId) {
    const hit = await streamflowHit(env, streamflowId, objectId);
    if (hit) return hit;
  }

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
    return ok({ kind, contentType, finalUrl: finalUrl.toString() }, 200, { 'cache-control': 'no-store, private' });
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
    const trackId = (params.get('sft') || 'main').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'main';
    if (env.DB && validStreamflowId(streamflowId) && /^(?:main|v\d+)$/.test(trackId)) {
      waitUntil(ensureStreamflowSchema(env).then(() => env.DB!.prepare(`INSERT INTO streamflow_hints
        (session_id, track_id, playlist_url, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET track_id = excluded.track_id,
          playlist_url = excluded.playlist_url, updated_at = excluded.updated_at`)
        .bind(streamflowId, trackId, finalUrl.toString(), Date.now()).run()).catch(() => {}));
    }
    return new Response(rewriteM3u8(text, finalUrl, provider, streamflowId, trackId), {
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'cache-control': 'private, max-age=10, stale-while-revalidate=20',
        'access-control-allow-origin': '*',
        'x-cactus-media-kind': 'hls',
        ...(streamflowId ? { 'x-cactus-streamflow': 'MANIFEST' } : {}),
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
        'cache-control': 'private, max-age=10, stale-while-revalidate=20',
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
  if (streamflowId && objectId) headers.set('x-cactus-streamflow', 'MISS');
  if (!headers.get('content-type') || contentType.includes('text/plain')) headers.set('content-type', 'application/octet-stream');
  const body = prefix.byteLength ? combinedBody(prefix, rest) : rest;
  return new Response(body, { status: upstream.status, headers });
};
