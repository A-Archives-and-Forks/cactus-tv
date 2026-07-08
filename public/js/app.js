import { api } from './api.js';
import { store } from './storage.js';
import { loadSubtitle, localSubtitle, playStream, stopStream } from './player.js?v=0.3.0';
import { createPlayerUI } from './player-ui.js?v=0.3.0';

const $ = selector => document.querySelector(selector);
const els = {
  brandName: $('#brandName'), footerName: $('#footerName'), topbar: $('#topbar'), hero: $('#hero'), heroBackdrop: $('#heroBackdrop'), heroArtwork: $('#heroArtwork'),
  heroTitle: $('#heroTitle'), heroMeta: $('#heroMeta'), heroOverview: $('#heroOverview'), heroPlayButton: $('#heroPlayButton'), heroInfoButton: $('#heroInfoButton'),
  searchForm: $('#searchForm'), searchInput: $('#searchInput'), homeSections: $('#homeSections'), resultsSection: $('#resultsSection'),
  mediaGrid: $('#mediaGrid'), emptyState: $('#emptyState'), skeletons: $('#skeletons'), notice: $('#notice'), sectionTitle: $('#sectionTitle'),
  sectionKicker: $('#sectionKicker'), resultCount: $('#resultCount'), detailDialog: $('#detailDialog'), detailContent: $('#detailContent'),
  playerDialog: $('#playerDialog'), playerShell: $('#videoShell'), player: $('#videoPlayer'), playerTitle: $('#playerTitle'), playerSubtitle: $('#playerSubtitle'),
  playerMessage: $('#playerMessage'), playerRetry: $('#playerRetry'), subtitleSelect: $('#subtitleSelect'), subtitleFile: $('#subtitleFile'), resumeHint: $('#resumeHint'),
  settingsDialog: $('#settingsDialog'), settingsButton: $('#settingsButton'), searchToggle: $('#searchToggle'), searchClose: $('#searchClose'), historyToggle: $('#historyToggle'), nativeHlsToggle: $('#nativeHlsToggle'),
  resumeToggle: $('#resumeToggle'), sourcePills: $('#sourcePills'), metadataCredit: $('#metadataCredit'), toast: $('#toast'),
};

let currentView = 'home';
let settings = store.settings();
let currentPlayback = null;
let featuredItem = null;
let activeSearchController = null;
let searchSequence = 0;
let playbackSequence = 0;

els.historyToggle.checked = settings.recordHistory;
els.nativeHlsToggle.checked = settings.preferNativeHls;
els.resumeToggle.checked = settings.resumePlayback;

const playerUI = createPlayerUI({
  dialog: els.playerDialog,
  shell: els.playerShell,
  video: els.player,
  message: els.playerMessage,
  retryButton: els.playerRetry,
});
function tryNextImageSource(img) {
  const original = img.dataset.originalSrc || '';
  if (original && !img.dataset.originalTried) {
    img.dataset.originalTried = '1';
    img.src = original;
    return true;
  }

  const proxy = img.dataset.proxySrc || '';
  if (proxy && !img.dataset.proxyRetried) {
    img.dataset.proxyRetried = '1';
    img.src = `${proxy}${proxy.includes('?') ? '&' : '?'}retry=${Date.now()}`;
    return true;
  }
  return false;
}

els.heroArtwork.addEventListener('error', () => {
  if (tryNextImageSource(els.heroArtwork)) return;
  els.hero.classList.remove('poster-mode');
  els.heroArtwork.removeAttribute('src');
  delete els.heroArtwork.dataset.proxySrc;
  delete els.heroArtwork.dataset.originalSrc;
  delete els.heroArtwork.dataset.originalTried;
  delete els.heroArtwork.dataset.proxyRetried;
});

// Register before any cards are rendered so cached failures cannot escape the fallback.
document.addEventListener('error', event => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  if (tryNextImageSource(img)) return;

  const isDetailCover = img.classList.contains('detail-cover');
  const isDetailThumb = img.classList.contains('detail-thumb');
  const fallback = Object.assign(document.createElement('div'), {
    className: isDetailCover ? 'detail-cover-fallback' : isDetailThumb ? 'detail-thumb detail-thumb-fallback' : 'poster-fallback',
    textContent: img.dataset.fallback || 'C',
  });
  img.replaceWith(fallback);
}, true);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}
function safeImage(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' && /(^|\.)doubanio\.com$/i.test(parsed.hostname)) {
      parsed.protocol = 'https:';
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function doubanIdOf(item) {
  const candidates = [item?.douban?.id, item?.doubanId, !item?.provider ? item?.id : ''];
  const value = candidates.map(candidate => String(candidate || '').trim()).find(candidate => /^\d{5,12}$/.test(candidate));
  return value || '';
}

function proxyImage(url, item = null) {
  const value = safeImage(url);
  if (!value) return '';

  try {
    const parsed = new URL(value);
    if (/(^|\.)doubanio\.com$/i.test(parsed.hostname)) {
      const params = new URLSearchParams({ rev: '12', url: value });
      const doubanId = doubanIdOf(item);
      const kind = item?.mediaType === 'movie' ? 'movie' : item?.mediaType === 'tv' ? 'tv' : '';
      if (doubanId) params.set('id', doubanId);
      if (kind) params.set('kind', kind);
      return `/api/image?${params.toString()}`;
    }
  } catch {
    return '';
  }

  return '';
}

function displayImage(url, item = null) {
  const value = safeImage(url);
  return proxyImage(value, item) || value;
}

function imageAttributes(url, fallback = '', item = null) {
  const original = safeImage(url);
  const proxy = proxyImage(original, item);
  const src = proxy || original;
  if (!src) return '';
  return `src="${escapeHtml(src)}"${proxy ? ` data-proxy-src="${escapeHtml(proxy)}" data-original-src="${escapeHtml(original)}"` : ''}${fallback ? ` data-fallback="${escapeHtml(fallback)}"` : ''}`;
}
function keyOf(item) { return item.key || `${item.provider}:${item.id}`; }
function titleOf(item) { return item.name || item.title || '未命名'; }
function savedItem(item) {
  return {
    key: keyOf(item), id: item.id, provider: item.provider, providerName: item.providerName,
    name: titleOf(item), pic: item.pic || item.poster, remarks: item.remarks,
    year: item.year, type: item.type, sources: item.sources, tmdb: item.tmdb,
  };
}
function toast(message, kind = '') {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
}
function showNotice(message = '', kind = '') {
  clearTimeout(showNotice.timer);
  els.notice.textContent = message;
  els.notice.className = `notice ${message ? '' : 'hidden'} ${kind}`;
  if (message && kind === 'warning') {
    showNotice.timer = setTimeout(() => els.notice.classList.add('hidden'), 5200);
  }
}
function formatTime(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function setLoading(loading) {
  els.skeletons.classList.toggle('hidden', !loading);
  els.mediaGrid.classList.toggle('hidden', loading);
  if (loading) {
    els.skeletons.innerHTML = Array.from({ length: 12 }, () => '<div class="skeleton"></div>').join('');
    els.emptyState.classList.add('hidden');
  }
}
function setActiveTab(view) {
  document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
}
function setCompactView(compact) {
  document.body.classList.toggle('compact-view', compact);
}
function cancelPendingSearch() {
  searchSequence += 1;
  activeSearchController?.abort();
  activeSearchController = null;
}

function renderHero(item) {
  featuredItem = item || null;
  els.hero.classList.remove('poster-mode');
  els.heroArtwork.removeAttribute('src');
  delete els.heroArtwork.dataset.proxySrc;
  delete els.heroArtwork.dataset.originalSrc;
  delete els.heroArtwork.dataset.originalTried;
  delete els.heroArtwork.dataset.proxyRetried;

  if (!item) {
    els.heroBackdrop.style.backgroundImage = 'radial-gradient(circle at 72% 28%, #3c0a0e 0, #18090b 25%, #090909 62%)';
    els.heroTitle.textContent = '今晚看什么？';
    els.heroMeta.innerHTML = '';
    els.heroOverview.textContent = '';
    return;
  }

  const backdrop = displayImage(item.backdrop || item.tmdb?.backdrop, item);
  const poster = displayImage(item.poster || item.pic || item.tmdb?.poster, item);
  const heroImage = backdrop || poster;

  els.heroBackdrop.style.backgroundImage = heroImage
    ? `url("${heroImage.replace(/["\\]/g, '\\$&')}")`
    : 'radial-gradient(circle at 72% 28%, #3c0a0e 0, #18090b 25%, #090909 62%)';

  if (!backdrop && poster) {
    els.hero.classList.add('poster-mode');
    const heroOriginal = safeImage(item.poster || item.pic || item.tmdb?.poster);
    els.heroArtwork.src = poster;
    els.heroArtwork.dataset.proxySrc = proxyImage(heroOriginal, item);
    els.heroArtwork.dataset.originalSrc = heroOriginal;
    els.heroArtwork.alt = titleOf(item);
  }

  els.heroTitle.textContent = titleOf(item);
  const rating = Number(item.rating || item.tmdb?.rating || item.douban?.rating || 0);
  const type = item.mediaType === 'tv' ? '剧集' : item.mediaType === 'movie' ? '电影' : item.type;
  const meta = [rating ? `★ ${rating.toFixed(1)}` : '', item.year, type].filter(Boolean);
  els.heroMeta.innerHTML = meta.map(value => `<span>${escapeHtml(value)}</span>`).join('');
  els.heroOverview.textContent = item.overview || item.tmdb?.overview || '';
}

function cardHtml(item, index, context = 'results') {
  const name = titleOf(item);
  const explicitBackdropSource = item.backdrop || item.tmdb?.backdrop || '';
  const portraitSource = item.pic || item.poster || item.tmdb?.poster || item.backdrop || item.tmdb?.backdrop || '';
  const explicitBackdrop = safeImage(explicitBackdropSource);
  const portraitVisual = safeImage(portraitSource);
  const preferPortrait = window.matchMedia('(max-width: 1024px)').matches;
  const visualSource = preferPortrait ? (portraitSource || explicitBackdropSource) : (explicitBackdropSource || portraitSource);
  const visual = safeImage(visualSource);
  const portraitOnly = !explicitBackdrop && Boolean(portraitVisual);
  const key = keyOf(item);
  const rating = Number(item.tmdb?.rating || item.rating || item.douban?.rating || 0);
  const favorite = context !== 'home' && store.isFavorite(key);
  const type = item.type || (item.mediaType === 'tv' ? '剧集' : item.mediaType === 'movie' ? '电影' : item.providerName || '');
  const primaryMeta = rating ? `★ ${rating.toFixed(1)}` : item.sourceCount > 1 ? `${item.sourceCount} 个片源` : '';
  const fallback = name.trim().slice(0, 1).toUpperCase() || 'C';

  const eagerHomeImage = context === 'home' && index < 6;
  const image = visual
    ? `<img loading="${eagerHomeImage ? 'eager' : 'lazy'}" decoding="async" fetchpriority="${eagerHomeImage && index < 2 ? 'auto' : 'low'}" referrerpolicy="no-referrer" ${imageAttributes(visualSource, fallback, item)} alt="${escapeHtml(name)}">`
    : `<div class="poster-fallback">${escapeHtml(fallback)}</div>`;

  const posterClass = portraitOnly ? 'poster poster-portrait-source' : 'poster';
  const ambientImage = displayImage(visualSource, item);
  const posterStyle = portraitOnly && ambientImage ? ` style="--poster-ambient:url(&quot;${escapeHtml(ambientImage)}&quot;)"` : '';

  return `<article class="media-card" tabindex="0" role="button" aria-label="查看 ${escapeHtml(name)}" data-index="${index}" data-context="${context}">
    <div class="${posterClass}"${posterStyle}>${image}
      ${item.remarks ? `<span class="badge">${escapeHtml(item.remarks)}</span>` : rating ? `<span class="rating">★ ${rating.toFixed(1)}</span>` : ''}
      ${context !== 'home' ? `<button type="button" class="favorite-button ${favorite ? 'active' : ''}" data-favorite="${escapeHtml(key)}" aria-label="${favorite ? '取消收藏' : '收藏'}">${favorite ? '♥' : '+'}</button>` : ''}
      <div class="card-overlay"><strong>${escapeHtml(name)}</strong><div class="card-meta">${primaryMeta ? `<span class="match">${escapeHtml(primaryMeta)}</span>` : ''}${item.year ? `<span>${escapeHtml(item.year)}</span>` : ''}${type ? `<span>${escapeHtml(type)}</span>` : ''}</div></div>
    </div>
  </article>`;
}

function bindCards(container, items, context) {
  if (!container) return;

  const activateCard = async (card, event) => {
    const item = items[Number(card.dataset.index)];
    if (!item) return;
    const favoriteButton = event?.target?.closest?.('[data-favorite]');
    if (favoriteButton) {
      event.stopPropagation();
      toggleFavorite(item, favoriteButton);
      return;
    }
    if (context === 'home') {
      const query = titleOf(item);
      els.searchInput.value = query;
      await search(query);
    } else {
      await openDetail(item);
    }
  };

  container.onclick = event => {
    const card = event.target.closest?.('.media-card');
    if (card && container.contains(card)) activateCard(card, event);
  };
  container.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest?.('.media-card');
    if (!card || !container.contains(card)) return;
    event.preventDefault();
    activateCard(card, event);
  };
}
function render(items, title, kicker) {
  const list = items || [];
  setCompactView(true);
  els.resultsSection.classList.remove('hidden');
  els.homeSections.classList.add('hidden');
  els.sectionTitle.textContent = title;
  els.sectionKicker.textContent = kicker;
  els.resultCount.textContent = list.length ? `${list.length} 个结果` : '';
  els.emptyState.classList.toggle('hidden', list.length > 0);
  els.mediaGrid.innerHTML = list.map((item, index) => cardHtml(item, index)).join('');
  bindCards(els.mediaGrid, list, 'results');
}

function renderHome(sections) {
  currentView = 'home';
  setCompactView(false);
  setActiveTab('home');
  els.resultsSection.classList.add('hidden');
  els.homeSections.classList.remove('hidden');
  if (!sections?.length) {
    renderHero(null);
    els.homeSections.innerHTML = '<div class="empty-state"><div class="empty-icon">C</div><h3>首页暂无内容</h3><p>可以直接使用上方搜索。</p></div>';
    return;
  }

  const firstSection = sections.find(section => section.items?.length);
  renderHero(firstSection?.items?.[0]);
  els.homeSections.innerHTML = sections.map((section, sectionIndex) => `<section class="catalog-section">
    <div class="section-heading"><h2>${escapeHtml(section.title)}</h2>
      <div class="row-controls" aria-label="滚动片单"><button type="button" class="row-control" data-row="${sectionIndex}" data-dir="-1" aria-label="向左">‹</button><button type="button" class="row-control" data-row="${sectionIndex}" data-dir="1" aria-label="向右">›</button></div>
    </div>
    <div class="media-row" data-section="${sectionIndex}">${section.items.map((item, index) => cardHtml(item, index, 'home')).join('')}</div>
  </section>`).join('');

  sections.forEach((section, index) => bindCards(els.homeSections.querySelector(`[data-section="${index}"]`), section.items, 'home'));
  els.homeSections.querySelectorAll('.row-control').forEach(button => button.addEventListener('click', () => {
    const row = els.homeSections.querySelector(`[data-section="${button.dataset.row}"]`);
    row?.scrollBy({ left: Number(button.dataset.dir) * Math.max(row.clientWidth * .82, 320), behavior: 'smooth' });
  }));
}

function toggleFavorite(item, button) {
  const normalized = savedItem(item);
  const active = store.toggleFavorite(normalized);
  button.classList.toggle('active', active);
  button.textContent = active ? '♥' : '+';
  button.setAttribute('aria-label', active ? '取消收藏' : '收藏');
  if (currentView === 'favorites') renderSavedView('favorites');
}

async function search(query) {
  const sequence = ++searchSequence;
  activeSearchController?.abort();
  const controller = new AbortController();
  activeSearchController = controller;

  currentView = 'search';
  setActiveTab('home');
  setCompactView(true);
  showNotice('');
  setLoading(true);
  els.resultsSection.classList.remove('hidden');
  els.homeSections.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try {
    const payload = await api.search(query, controller.signal);
    if (sequence !== searchSequence) return;
    render(payload.items || [], `“${query}”`, 'SEARCH RESULTS');
    if (payload.errors?.length) showNotice(`部分数据源不可用：${payload.errors.map(error => error.provider).join('、')}`, 'warning');
  } catch (error) {
    if (sequence !== searchSequence || error?.name === 'AbortError') return;
    render([], '搜索失败', 'ERROR');
    showNotice(error.message, 'error');
  } finally {
    if (sequence === searchSequence) {
      setLoading(false);
      if (activeSearchController === controller) activeSearchController = null;
    }
  }
}

async function openDetail(item, sourceOverride = null) {
  const source = sourceOverride || { provider: item.provider, id: item.id, providerName: item.providerName };
  els.detailContent.innerHTML = '<div class="empty-state"><div class="empty-icon">C</div><p>正在加载详情…</p></div>';
  if (!els.detailDialog.open) els.detailDialog.showModal();

  try {
    const payload = await api.detail(source.provider, source.id);
    const detail = payload.item;
    const poster = safeImage(detail.pic);
    const cover = safeImage(detail.backdrop || detail.tmdb?.backdrop || detail.pic);
    const lines = detail.lines || [];
    const allEpisodes = lines.flatMap((line, lineIndex) =>
      (line.episodes || []).map((episode, episodeIndex) => ({ episode, lineIndex, episodeIndex }))
    );
    const firstPlayable = allEpisodes[0];
    const description = String(detail.content || '').trim();
    const metaValues = [
      detail.tmdb?.rating ? `★ ${Number(detail.tmdb.rating).toFixed(1)}` : '',
      detail.douban?.rating ? `豆瓣 ${Number(detail.douban.rating).toFixed(1)}` : '',
      detail.year,
      detail.type,
      detail.area,
      detail.lang,
    ].filter(Boolean);

    const sourceButtons = (item.sources || []).map(candidate => `<button class="source-choice ${candidate.provider === detail.provider ? 'active' : ''}" data-provider="${escapeHtml(candidate.provider)}" data-id="${escapeHtml(candidate.id)}">${escapeHtml(candidate.providerName)}${candidate.latency ? `<small>${candidate.latency}ms</small>` : ''}</button>`).join('');

    const credits = [
      detail.director ? `<p><span>导演</span>${escapeHtml(detail.director)}</p>` : '',
      detail.actors ? `<p><span>演员</span>${escapeHtml(detail.actors)}</p>` : '',
    ].filter(Boolean).join('');

    const lineHtml = lines.map((line, lineIndex) => {
      const rawName = String(line.name || '').trim();
      const lineName = lines.length === 1
        ? '选集'
        : (/m3u8|线路|line|source/i.test(rawName) ? `线路 ${lineIndex + 1}` : rawName || `线路 ${lineIndex + 1}`);
      return `<section class="episode-block">
        <div class="episode-heading"><h3>${escapeHtml(lineName)}</h3><span>${line.episodes.length} 集</span></div>
        <div class="episodes">${line.episodes.map((episode, episodeIndex) => `<button class="episode" data-line="${lineIndex}" data-episode="${episodeIndex}">${escapeHtml(episode.name || `第${episodeIndex + 1}集`)}${episode.proxied ? '<i>代理</i>' : ''}</button>`).join('')}</div>
      </section>`;
    }).join('');

    els.detailContent.innerHTML = `<section class="detail-masthead">
      ${cover ? `<img class="detail-cover" referrerpolicy="no-referrer" ${imageAttributes(detail.backdrop || detail.tmdb?.backdrop || detail.pic, 'C', detail)} alt="">` : '<div class="detail-cover-fallback">C</div>'}
      <div class="detail-masthead-shade"></div>
    </section>
    <div class="detail-main">
      <div class="detail-title-row">
        ${poster ? `<img class="detail-thumb" referrerpolicy="no-referrer" ${imageAttributes(detail.pic, 'C', detail)} alt="${escapeHtml(detail.name)}">` : ''}
        <div class="detail-title-copy">
          <h2>${escapeHtml(detail.name)}</h2>
          <div class="detail-meta">${metaValues.map(value => `<span>${escapeHtml(value)}</span>`).join('')}</div>
        </div>
      </div>
      ${firstPlayable ? `<button class="detail-primary-play" type="button" data-line="${firstPlayable.lineIndex}" data-episode="${firstPlayable.episodeIndex}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" fill="currentColor"/></svg>播放${escapeHtml(firstPlayable.episode.name || '第1集')}</button>` : ''}
      ${sourceButtons ? `<div class="detail-source-bar"><span>片源</span><div class="source-choices">${sourceButtons}</div></div>` : ''}
      ${description ? `<div class="detail-overview-wrap"><p class="detail-overview ${description.length > 110 ? 'collapsed' : ''}">${escapeHtml(description)}</p>${description.length > 110 ? '<button class="detail-more" type="button">展开</button>' : ''}</div>` : ''}
      ${credits ? `<details class="detail-credits"><summary>演职员与信息</summary>${credits}</details>` : ''}
      ${lineHtml || '<div class="episode-block"><p class="muted">此数据源没有返回可播放条目。</p></div>'}
    </div>`;

    els.detailContent.querySelectorAll('.source-choice').forEach(button => button.addEventListener('click', () => openDetail(item, { provider: button.dataset.provider, id: button.dataset.id })));
    els.detailContent.querySelectorAll('.episode, .detail-primary-play').forEach(button => button.addEventListener('click', () => {
      const episode = lines[Number(button.dataset.line)]?.episodes?.[Number(button.dataset.episode)];
      if (episode) openPlayer(detail, episode);
    }));
    els.detailContent.querySelector('.detail-more')?.addEventListener('click', event => {
      const overview = els.detailContent.querySelector('.detail-overview');
      const collapsed = overview?.classList.toggle('collapsed');
      event.currentTarget.textContent = collapsed ? '展开' : '收起';
    });
  } catch (error) {
    els.detailContent.innerHTML = `<div class="empty-state"><div class="empty-icon">!</div><h3>详情加载失败</h3><p>${escapeHtml(error.message)}</p><button class="primary-button" id="retryDetail">重试</button></div>`;
    $('#retryDetail')?.addEventListener('click', () => openDetail(item, source));
  }
}

async function openPlayer(detail, episode) {
  const sequence = ++playbackSequence;
  const playUrl = episode.playbackUrl || episode.url;
  els.playerTitle.textContent = detail.name;
  els.playerSubtitle.textContent = episode.name;
  if (!els.playerDialog.open) els.playerDialog.showModal();

  const historyItem = store.progress(detail.key);
  const resumeAt = settings.resumePlayback && historyItem?.url === playUrl
    ? Number(historyItem.position || 0)
    : 0;
  els.resumeHint.textContent = resumeAt > 5 ? `将从 ${formatTime(resumeAt)} 继续` : '';
  currentPlayback = {
    detail,
    episode,
    playUrl,
    item: { ...savedItem(detail), key: detail.key },
    lastSync: 0,
  };
  populateSubtitles(detail.subtitles || []);
  playerUI.reset();
  requestAnimationFrame(() => playerUI.focus());

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: detail.name || 'Cactus TV',
        artist: episode.name || '',
        artwork: detail.pic ? [{ src: displayImage(detail.pic, detail) }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => els.player.play());
      navigator.mediaSession.setActionHandler('pause', () => els.player.pause());
      navigator.mediaSession.setActionHandler('seekbackward', event => {
        els.player.currentTime = Math.max(0, els.player.currentTime - (event.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', event => {
        els.player.currentTime = Math.min(els.player.duration || Infinity, els.player.currentTime + (event.seekOffset || 10));
      });
    } catch {}
  }

  const startPlayback = async startAt => {
    if (sequence !== playbackSequence || !els.playerDialog.open) return;
    playerUI.reset();
    try {
      await playStream(els.player, playUrl, settings.preferNativeHls, startAt);
    } catch (error) {
      if (sequence !== playbackSequence || !els.playerDialog.open) return;
      playerUI.showError(new Error(`${error.message}。可尝试重新加载、切换线路，或检查媒体域名白名单与代理配置。`));
    }
  };

  playerUI.setRetry(() => {
    const retryAt = Number.isFinite(els.player.currentTime) ? els.player.currentTime : resumeAt;
    startPlayback(retryAt);
  });

  if (settings.recordHistory) saveHistory(resumeAt, Number(historyItem?.duration || 0));
  await startPlayback(resumeAt);
}
function populateSubtitles(subtitles) {
  els.subtitleSelect.innerHTML = '<option value="">关闭</option>' + subtitles.map((subtitle, index) => `<option value="${index}">${escapeHtml(subtitle.name)} · ${escapeHtml(subtitle.lang || '')}</option>`).join('');
  els.subtitleSelect._items = subtitles;
  els.subtitleFile.value = '';
}

function saveHistory(position = els.player.currentTime || 0, duration = els.player.duration || 0) {
  if (!currentPlayback || !settings.recordHistory) return;
  const { episode, item } = currentPlayback;
  const record = { ...item, episodeName: episode.name, url: episode.playbackUrl || episode.url, position, duration };
  store.addHistory(record);
  store.updateProgress(item.key, position, duration, record.url);
}

function renderSavedView(view) {
  cancelPendingSearch();
  currentView = view;
  setActiveTab(view);
  setCompactView(true);
  showNotice('');
  const list = view === 'favorites' ? store.favorites() : store.history();
  render(list, view === 'favorites' ? '我的片单' : '继续观看', 'SAVED ON THIS DEVICE');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSearch() {
  document.body.classList.add('search-open');
  requestAnimationFrame(() => els.searchInput.focus());
}

function closeSearch() {
  document.body.classList.remove('search-open');
}

els.searchForm.addEventListener('submit', event => {
  event.preventDefault();
  const query = els.searchInput.value.trim();
  if (query) {
    closeSearch();
    search(query);
  }
});
els.searchToggle.addEventListener('click', openSearch);
els.searchClose.addEventListener('click', closeSearch);
els.heroPlayButton.addEventListener('click', () => {
  const query = featuredItem ? titleOf(featuredItem) : els.searchInput.value.trim();
  if (query) {
    els.searchInput.value = query;
    search(query);
  } else {
    openSearch();
  }
});
els.heroInfoButton.addEventListener('click', () => els.homeSections.querySelector('.catalog-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', async () => {
  const view = tab.dataset.view;
  if (view === 'home') {
    cancelPendingSearch();
    currentView = 'home';
    setActiveTab('home');
    try {
      const home = await api.home();
      if (currentView !== 'home') return;
      renderHome(home.sections);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (home.notice) showNotice(home.notice, 'warning');
    } catch (error) {
      showNotice(error.message, 'error');
    }
  } else {
    renderSavedView(view);
  }
}));

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
}));
els.settingsButton.addEventListener('click', () => els.settingsDialog.showModal());
[els.historyToggle, els.nativeHlsToggle, els.resumeToggle].forEach(input => input.addEventListener('change', () => {
  settings = {
    recordHistory: els.historyToggle.checked,
    preferNativeHls: els.nativeHlsToggle.checked,
    resumePlayback: els.resumeToggle.checked,
  };
  store.saveSettings(settings);
}));
els.subtitleSelect.addEventListener('change', async () => {
  try {
    const item = els.subtitleSelect.value === '' ? null : els.subtitleSelect._items[Number(els.subtitleSelect.value)];
    await loadSubtitle(els.player, item);
  } catch (error) {
    toast(error.message, 'error');
  }
});
els.subtitleFile.addEventListener('change', async () => {
  const file = els.subtitleFile.files?.[0];
  if (!file) return;
  try {
    const subtitle = await localSubtitle(file);
    await loadSubtitle(els.player, subtitle);
    toast('本地字幕已加载');
  } catch (error) {
    toast(error.message, 'error');
  }
});
els.player.addEventListener('timeupdate', () => {
  if (!currentPlayback || Date.now() - currentPlayback.lastSync < 15000) return;
  currentPlayback.lastSync = Date.now();
  saveHistory();
});
els.playerDialog.addEventListener('close', () => {
  playbackSequence += 1;
  saveHistory();
  playerUI.setRetry(null);
  stopStream(els.player);
  currentPlayback = null;
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = null; } catch {}
  }
});
window.addEventListener('pagehide', () => saveHistory());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveHistory();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('search-open')) closeSearch();
});
let scrollFrame = 0;
window.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    els.topbar.classList.toggle('scrolled', window.scrollY > 28);
    scrollFrame = 0;
  });
}, { passive: true });
window.addEventListener('unhandledrejection', event => {
  console.error(event.reason);
  toast(event.reason?.message || '页面发生未处理错误', 'error');
});

(async function init() {
  renderHero(null);
  try {
    const health = await api.health();
    const siteName = health.siteName || 'Cactus TV';
    const brandBase = siteName.replace(/\s*TV\s*$/i, '').trim() || 'Cactus';
    els.brandName.textContent = brandBase.toUpperCase();
    els.footerName.textContent = siteName;
    document.title = siteName;
    if (health.tmdbReady) {
      els.metadataCredit.innerHTML = '<a class="footer-link" href="https://www.themoviedb.org" target="_blank" rel="noreferrer">Metadata by TMDB</a>';
    } else {
      els.metadataCredit.textContent = '影片资料来自豆瓣';
    }
    els.sourcePills.innerHTML = (health.providers || []).map(provider => `<span class="source-pill ${provider.proxyEnabled ? 'proxied' : ''}">${escapeHtml(provider.name)}</span>`).join('');
    if (!health.providers?.length) showNotice('尚未配置数据源。请打开 /admin.html 添加兼容接口。', 'warning');
    const home = await api.home();
    if (currentView === 'home') {
      renderHome(home.sections);
      if (home.notice) showNotice(home.notice, 'warning');
    }
  } catch (error) {
    showNotice(error.message || '后端函数未连接', 'error');
  }
})();
