import { HttpError, ok } from '../../_shared/http';
import { fetchMediaJson, getMediaSession, mapMediaItem } from '../../_shared/media';
import type { AppData, Env } from '../../_shared/types';

const LIST_FIELDS = [
  'Overview', 'Genres', 'DateCreated', 'DateLastMediaAdded', 'CommunityRating', 'CriticRating', 'OfficialRating',
  'ProductionYear', 'RunTimeTicks', 'UserData', 'PrimaryImageAspectRatio', 'SeriesInfo', 'Path',
].join(',');

function itemsFrom(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.Items) ? payload.Items : [];
}

function uniqueItems(items: any[]): any[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const id = String(item?.Id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function mapItems(items: any[]) {
  return uniqueItems(items).map(mapMediaItem).filter(item => item.id);
}

async function fetchUserItems(session: any, params: Record<string, unknown>, includeItemTypes = 'Movie,Series,Episode') {
  return fetchMediaJson(session, `/Users/${encodeURIComponent(session.userId)}/Items`, {}, {
    Recursive: true,
    IncludeItemTypes: includeItemTypes,
    Fields: LIST_FIELDS,
    EnableImages: true,
    ImageTypeLimit: 1,
    EnableUserData: true,
    ...params,
  });
}

async function listItems(session: any, params: Record<string, unknown>, includeItemTypes = 'Movie,Series,Episode') {
  return mapItems(itemsFrom(await fetchUserItems(session, params, includeItemTypes)));
}

function hashValue(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function personalizedRecommendations(candidates: any[], favorites: any[], recent: any[], excludedIds: Set<string>) {
  const genreWeights = new Map<string, number>();
  const addGenres = (items: any[], weight: number) => {
    for (const item of items.slice(0, 30)) {
      for (const genre of Array.isArray(item?.Genres) ? item.Genres : []) {
        const key = String(genre || '').trim().toLowerCase();
        if (key) genreWeights.set(key, (genreWeights.get(key) || 0) + weight);
      }
    }
  };
  addGenres(favorites, 3.5);
  addGenres(recent, 2);

  const year = new Date().getUTCFullYear();
  return uniqueItems(candidates)
    .filter(item => item?.Id && !excludedIds.has(String(item.Id)))
    .map(item => {
      const rating = Number(item?.CommunityRating || item?.CriticRating || 0);
      const productionYear = Number(item?.ProductionYear || 0);
      const recency = productionYear ? Math.max(0, 8 - Math.abs(year - productionYear)) * 0.28 : 0;
      const genreScore = (Array.isArray(item?.Genres) ? item.Genres : []).reduce((total: number, genre: unknown) => {
        return total + (genreWeights.get(String(genre || '').trim().toLowerCase()) || 0);
      }, 0);
      const favoriteBoost = item?.UserData?.IsFavorite ? 2 : 0;
      const playedPenalty = item?.UserData?.Played ? 18 : 0;
      return { item, score: rating * 1.45 + genreScore + recency + favoriteBoost - playedPenalty + hashValue(String(item.Id)) * 0.2 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 24)
    .map(entry => entry.item);
}

function nativeRecommendationItems(payload: any): any[] {
  const groups = Array.isArray(payload) ? payload : [];
  return uniqueItems(groups.flatMap(group => Array.isArray(group?.Items) ? group.Items : []));
}

async function playlistItems(session: any, playlistId: string) {
  try {
    const payload = await fetchMediaJson(session, `/Playlists/${encodeURIComponent(playlistId)}/Items`, {}, {
      UserId: session.userId,
      Fields: LIST_FIELDS,
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableUserData: true,
      Limit: 500,
    });
    return itemsFrom(payload);
  } catch {
    const payload = await fetchUserItems(session, {
      ParentId: playlistId,
      Recursive: false,
      Limit: 500,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
    }, 'Movie,Series,Episode,Video');
    return itemsFrom(payload);
  }
}

async function homeSections(session: any) {
  const user = encodeURIComponent(session.userId);
  const settled = await Promise.allSettled([
    fetchMediaJson(session, `/Users/${user}/Views`),
    fetchMediaJson(session, `/Users/${user}/Items/Resume`, {}, {
      Limit: 24,
      MediaTypes: 'Video',
      Fields: LIST_FIELDS,
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableUserData: true,
    }),
    fetchMediaJson(session, `/Users/${user}/Items/Latest`, {}, {
      Limit: 30,
      IncludeItemTypes: 'Movie,Series,Episode',
      Fields: LIST_FIELDS,
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableUserData: true,
      GroupItems: true,
    }),
    fetchMediaJson(session, '/Shows/NextUp', {}, {
      UserId: session.userId,
      Limit: 24,
      Fields: LIST_FIELDS,
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableUserData: true,
      DisableFirstEpisode: false,
    }),
    fetchUserItems(session, {
      IsFavorite: true,
      Limit: 36,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
    }),
    fetchUserItems(session, {
      IsPlayed: true,
      Limit: 40,
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
    }),
    fetchMediaJson(session, '/Movies/Recommendations', {}, {
      UserId: session.userId,
      CategoryLimit: 5,
      ItemLimit: 24,
      Fields: LIST_FIELDS,
    }),
    fetchUserItems(session, {
      IsPlayed: false,
      Limit: 160,
      SortBy: 'CommunityRating,DateCreated,SortName',
      SortOrder: 'Descending',
    }),
  ]);

  const value = (index: number, fallback: any = {}) => settled[index].status === 'fulfilled' ? (settled[index] as PromiseFulfilledResult<any>).value : fallback;
  const viewsPayload = value(0);
  const resumeRaw = itemsFrom(value(1));
  const latestRaw = itemsFrom(value(2));
  const nextUpRaw = itemsFrom(value(3));
  const favoritesRaw = itemsFrom(value(4));
  const recentRaw = itemsFrom(value(5));
  const nativeRaw = nativeRecommendationItems(value(6, []));
  const candidateRaw = itemsFrom(value(7));

  const allViews = itemsFrom(viewsPayload).filter(view => view?.Id);
  const regularViews = allViews
    .filter(view => !['playlists', 'livetv'].includes(String(view?.CollectionType || '').toLowerCase()))
    .slice(0, 6);
  const playlistViews = allViews.filter(view => String(view?.CollectionType || '').toLowerCase() === 'playlists');

  const [viewResults, playlistResults] = await Promise.all([
    Promise.allSettled(regularViews.map(view => listItems(session, {
      ParentId: String(view.Id),
      Limit: 24,
      StartIndex: 0,
      SortBy: 'DateCreated,SortName',
      SortOrder: 'Descending',
    }))),
    Promise.allSettled((playlistViews.length ? playlistViews : [{ Id: '' }]).map(view => listItems(session, {
      ...(view.Id ? { ParentId: String(view.Id) } : {}),
      Limit: 50,
      StartIndex: 0,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
    }, 'Playlist'))),
  ]);

  const excludedIds = new Set<string>([
    ...resumeRaw, ...nextUpRaw, ...favoritesRaw, ...recentRaw.slice(0, 15),
  ].map(item => String(item?.Id || '')).filter(Boolean));
  const recommendationRaw = uniqueItems([
    ...nativeRaw,
    ...personalizedRecommendations(candidateRaw, favoritesRaw, recentRaw, excludedIds),
  ]).filter(item => !excludedIds.has(String(item?.Id || ''))).slice(0, 24);

  const sections: any[] = [];
  const addSection = (id: string, title: string, kicker: string, rawItems: any[]) => {
    const items = mapItems(rawItems);
    if (items.length) sections.push({ id, title, kicker, items });
  };

  addSection('resume', '继续观看', 'CONTINUE', resumeRaw);
  addSection('next-up', '下一集', 'NEXT UP', nextUpRaw);
  addSection('favorites', '服务器收藏', 'FAVORITES', favoritesRaw);
  addSection('recommended', '为你推荐', 'RECOMMENDED', recommendationRaw);
  addSection('latest', '最近加入', 'LATEST', latestRaw);

  const playlists = uniqueItems(playlistResults.flatMap(result => result.status === 'fulfilled' ? result.value : []));
  if (playlists.length) sections.push({ id: 'playlists', title: '播放列表', kicker: 'PLAYLISTS', items: playlists });

  viewResults.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value.length) return;
    sections.push({
      id: `view-${String(regularViews[index].Id)}`,
      title: String(regularViews[index].Name || '媒体库'),
      kicker: String(regularViews[index].CollectionType || 'LIBRARY').toUpperCase(),
      items: result.value,
    });
  });

  return {
    sections,
    views: regularViews.map(view => ({
      id: String(view.Id),
      name: String(view.Name || '媒体库'),
      collectionType: String(view.CollectionType || ''),
    })),
  };
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const params = new URL(request.url).searchParams;
  const session = await getMediaSession(params.get('session'));
  const mode = String(params.get('mode') || 'home');

  if (mode === 'home') {
    const result = await homeSections(session);
    return ok({ ...result, serverName: session.serverName, userName: session.userName }, 200, {
      'cache-control': 'private, no-store',
    });
  }

  const limit = Math.max(1, Math.min(mode === 'playlist' ? 500 : 100, Number(params.get('limit') || 60)));
  const start = Math.max(0, Number(params.get('start') || 0));
  const parent = String(params.get('parent') || '').trim();
  const query = String(params.get('q') || '').trim().slice(0, 100);

  if (mode === 'playlist') {
    if (!parent || parent.length > 200) throw new HttpError(400, '播放列表 ID 无效', 'MEDIA_PLAYLIST_ID_INVALID');
    const [metadata, rawItems] = await Promise.all([
      fetchMediaJson(session, `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(parent)}`, {}, {
        Fields: LIST_FIELDS,
        EnableImages: true,
        EnableUserData: true,
      }).catch(() => null),
      playlistItems(session, parent),
    ]);
    return ok({
      title: String(metadata?.Name || '播放列表'),
      items: mapItems(rawItems).slice(start, start + limit),
      start,
      limit,
      serverName: session.serverName,
    }, 200, { 'cache-control': 'private, no-store' });
  }

  if (mode === 'favorites') {
    const items = await listItems(session, {
      IsFavorite: true,
      Limit: limit,
      StartIndex: start,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
    });
    return ok({ items, start, limit, serverName: session.serverName }, 200, {
      'cache-control': 'private, no-store',
    });
  }

  if (mode === 'search' && !query) throw new HttpError(400, '请输入搜索关键词', 'MEDIA_SEARCH_QUERY_REQUIRED');
  if (!['search', 'items'].includes(mode)) throw new HttpError(400, '媒体库请求类型无效', 'MEDIA_LIBRARY_MODE_INVALID');

  const items = await listItems(session, {
    ...(parent ? { ParentId: parent } : {}),
    ...(query ? { SearchTerm: query } : {}),
    Limit: limit,
    StartIndex: start,
    SortBy: query ? 'SortName' : 'DateCreated,SortName',
    SortOrder: query ? 'Ascending' : 'Descending',
  });

  return ok({ items, start, limit, query, serverName: session.serverName }, 200, {
    'cache-control': 'private, no-store',
  });
};
