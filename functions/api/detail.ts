import { HttpError, ok } from '../_shared/http';
import { getSetting } from '../_shared/db';
import { bestTmdbMatch, doubanSearch, resolveMetadataSource, searchTmdb, tmdbDetail } from '../_shared/metadata';
import { buildCmsUrl, fetchJson, findProvider, validateHttpsUrl } from '../_shared/providers';
import { issueMediaTicket, type MediaTicket } from '../_shared/media-ticket';
import type { AppData, Env, Provider } from '../_shared/types';

function proxyInfo(provider: Provider, target: string, ticket: MediaTicket | null) {
  let normalized = target;
  let mediaHost = '';
  try {
    normalized = validateHttpsUrl(target);
    mediaHost = new URL(normalized).hostname.toLowerCase();
  } catch {
    return {
      playbackUrl: target,
      proxied: false,
      proxyMode: 'direct',
      proxyReason: '片源地址不是可代理的 HTTPS 地址',
      mediaHost,
    };
  }

  if (!provider.proxyEnabled) {
    return {
      playbackUrl: normalized,
      proxied: false,
      proxyMode: 'direct',
      proxyReason: '当前数据源未开启播放代理',
      mediaHost,
    };
  }

  const allowed = new Set([new URL(provider.baseUrl).hostname.toLowerCase(), ...provider.mediaHosts]);
  const allowlisted = allowed.has(mediaHost);
  if (!allowlisted && !ticket) {
    return {
      playbackUrl: normalized,
      proxied: false,
      proxyMode: 'direct',
      proxyReason: `媒体域名 ${mediaHost} 未加入白名单，且站点未生成临时媒体凭证`,
      mediaHost,
    };
  }

  const params = new URLSearchParams({ provider: provider.id, url: normalized });
  if (ticket) {
    params.set('mt', ticket.token);
    params.set('mte', String(ticket.expires));
  }
  return {
    playbackUrl: `/api/stream?${params.toString()}`,
    proxied: true,
    proxyMode: allowlisted ? 'allowlist' : 'ticket',
    proxyReason: '',
    mediaHost,
  };
}

function parseLines(fromRaw: string, urlRaw: string, provider: Provider, ticket: MediaTicket | null) {
  const names = fromRaw.split('$$$');
  return urlRaw.split('$$$').map((group, index) => ({
    name: names[index] || `线路 ${index + 1}`,
    episodes: group.split('#').map(entry => {
      const splitAt = entry.indexOf('$');
      if (splitAt < 0) return null;
      const url = entry.slice(splitAt + 1).trim();
      if (!/^https?:\/\//i.test(url)) return null;
      const proxy = proxyInfo(provider, url, ticket);
      return {
        name: entry.slice(0, splitAt).trim() || '播放',
        url,
        ...proxy,
      };
    }).filter(Boolean),
  })).filter(line => line.episodes.length > 0);
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider') || '';
  const id = url.searchParams.get('id') || '';
  if (!providerId || !id || id.length > 128) throw new HttpError(400, '缺少 provider 或 id', 'INVALID_DETAIL_REQUEST');
  const provider = await findProvider(env, providerId);
  if (!provider || !provider.enabled) throw new HttpError(404, '数据源不存在或未启用', 'PROVIDER_NOT_FOUND');
  const payload = await fetchJson(buildCmsUrl(provider, { ac: 'detail', ids: id }), provider);
  const item = Array.isArray(payload?.list) ? payload.list[0] : null;
  if (!item) throw new HttpError(404, '没有找到详情', 'DETAIL_NOT_FOUND');
  const name = String(item.vod_name ?? '未命名');
  const year = String(item.vod_year ?? '');
  const preference = await getSetting(env, 'metadata_source', 'auto');
  const source = resolveMetadataSource(preference, env);

  let tmdb: any = null;
  let douban: any = null;
  if (source === 'tmdb' && env.TMDB_BEARER_TOKEN) {
    const candidates = await searchTmdb(name, env);
    const matched = bestTmdbMatch(name, year, candidates);
    tmdb = matched ? await tmdbDetail(matched.id, matched.mediaType, env) : null;
    if (!tmdb && preference === 'auto') douban = await doubanSearch(name, env);
  } else {
    douban = await doubanSearch(name, env);
  }

  const itemKey = `${provider.id}:${String(item.vod_id ?? id)}`;
  const mediaTicket = provider.proxyEnabled ? await issueMediaTicket(env, provider.id) : null;
  let subtitles: any[] = [];
  if (env.DB) {
    try {
      const result = await env.DB.prepare('SELECT id, name, lang, url, format FROM subtitles WHERE item_key = ? AND enabled = 1 ORDER BY created_at ASC').bind(itemKey).all();
      subtitles = result.results || [];
    } catch { /* 数据库尚未初始化 */ }
  }
  const rawSubtitle = String(item.vod_sub || '').trim();
  if (/^https:\/\//i.test(rawSubtitle)) subtitles.unshift({ id: 'source', name: '数据源字幕', lang: 'zh', url: rawSubtitle, format: rawSubtitle.split('.').pop() || 'vtt' });
  return ok({ item: {
    key: itemKey, id: String(item.vod_id ?? id), provider: provider.id, providerName: provider.name,
    name, pic: tmdb?.poster || douban?.poster || String(item.vod_pic ?? ''), backdrop: tmdb?.backdrop || '', remarks: String(item.vod_remarks ?? ''),
    year: year || tmdb?.year || douban?.year || '', type: String(item.type_name ?? item.vod_class ?? ''), area: String(item.vod_area ?? ''),
    lang: String(item.vod_lang ?? ''), content: tmdb?.overview || String(item.vod_content ?? item.vod_blurb ?? '').replace(/<[^>]+>/g, '').slice(0, 3000),
    director: String(item.vod_director ?? ''), actors: String(item.vod_actor ?? ''), lines: parseLines(String(item.vod_play_from ?? ''), String(item.vod_play_url ?? ''), provider, mediaTicket),
    tmdb, douban, metadataSource: source, subtitles, proxyEnabled: provider.proxyEnabled,
  }}, 200, { 'cache-control': 'private, max-age=60' });
};
