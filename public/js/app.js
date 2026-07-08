import { api } from './api.js?v=0.4.0';
import { store } from './storage.js?v=0.4.0';
import { loadSubtitle, localSubtitle, playStream, stopStream } from './player.js?v=0.4.0';
import { createPlayerUI } from './player-ui.js?v=0.4.0';

const $ = selector => document.querySelector(selector);
const els = {
  brand: $('.brand'), brandName: $('#brandName'), footerName: $('#footerName'), topbar: $('#topbar'),
  hero: $('#hero'), heroBackdrop: $('#heroBackdrop'), heroArtwork: $('#heroArtwork'), heroTitle: $('#heroTitle'),
  heroMeta: $('#heroMeta'), heroOverview: $('#heroOverview'), heroPlayButton: $('#heroPlayButton'), heroInfoButton: $('#heroInfoButton'),
  searchForm: $('#searchForm'), searchInput: $('#searchInput'), searchToggle: $('#searchToggle'), searchClose: $('#searchClose'),
  categoryNav: $('#categoryNav'), homeSections: $('#homeSections'), resultsSection: $('#resultsSection'), resultFilters: $('#resultFilters'),
  mediaGrid: $('#mediaGrid'), loadMoreButton: $('#loadMoreButton'), emptyState: $('#emptyState'), skeletons: $('#skeletons'),
  notice: $('#notice'), sectionTitle: $('#sectionTitle'), sectionKicker: $('#sectionKicker'), resultCount: $('#resultCount'),
  detailDialog: $('#detailDialog'), detailContent: $('#detailContent'),
  playerDialog: $('#playerDialog'), playerShell: $('#videoShell'), player: $('#videoPlayer'), playerTitle: $('#playerTitle'),
  playerSubtitle: $('#playerSubtitle'), playerMessage: $('#playerMessage'), playerRetry: $('#playerRetry'),
  playerPrev: $('#playerPrev'), playerNext: $('#playerNext'), playerSwitchSource: $('#playerSwitchSource'), playbackStatus: $('#playbackStatus'),
  nextEpisodePrompt: $('#nextEpisodePrompt'), nextEpisodeText: $('#nextEpisodeText'), nextEpisodeNow: $('#nextEpisodeNow'), nextEpisodeCancel: $('#nextEpisodeCancel'),
  subtitleSelect: $('#subtitleSelect'), subtitleFile: $('#subtitleFile'), resumeHint: $('#resumeHint'),
  settingsDialog: $('#settingsDialog'), settingsButton: $('#settingsButton'), historyToggle: $('#historyToggle'),
  nativeHlsToggle: $('#nativeHlsToggle'), resumeToggle: $('#resumeToggle'), failoverToggle: $('#failoverToggle'), autoNextToggle: $('#autoNextToggle'),
  sourcePills: $('#sourcePills'), metadataCredit: $('#metadataCredit'), toast: $('#toast'),
};

const PAGE_SIZE = 24;
let currentView = 'home';
let settings = store.settings();
let featuredItem = null;
let homeSectionsData = [];
let currentResults = [];
let currentResultContext = 'results';
let currentResultTitle = '';
let currentResultKicker = '';
let visibleResultCount = PAGE_SIZE;
let resultFilters = { kind: 'all', year: 'all', source: 'all' };
let activeSearchController = null;
let searchSequence = 0;
let currentSearchQuery = '';
let currentDetailContext = null;
let detailSequence = 0;
let playbackSequence = 0;
let currentPlayback = null;
let routeApplying = false;
let nextEpisodeTimer = 0;
let nextEpisodeDeadline = 0;
let nextEpisodeTarget = null;

els.historyToggle.checked = settings.recordHistory;
els.nativeHlsToggle.checked = settings.preferNativeHls;
els.resumeToggle.checked = settings.resumePlayback;
els.failoverToggle.checked = settings.autoFailover;
els.autoNextToggle.checked = settings.autoNext;

const playerUI = createPlayerUI({
  dialog: els.playerDialog,
  shell: els.playerShell,
  video: els.player,
  message: els.playerMessage,
  retryButton: els.playerRetry,
});

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function safeImage(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' && /(^|\.)doubanio\.com$/i.test(parsed.hostname)) parsed.protocol = 'https:';
    return parsed.toString();
  } catch { return ''; }
}

function doubanIdOf(item) {
  const candidates = [item?.douban?.id, item?.doubanId, !item?.provider ? item?.id : ''];
  return candidates.map(value => String(value || '').trim()).find(value => /^\d{5,12}$/.test(value)) || '';
}

function proxyImage(url, item = null) {
  const value = safeImage(url);
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!/(^|\.)doubanio\.com$/i.test(parsed.hostname)) return '';
    const params = new URLSearchParams({ rev: '14', url: value });
    const doubanId = doubanIdOf(item);
    const kind = item?.mediaType === 'movie' ? 'movie' : item?.mediaType === 'tv' ? 'tv' : '';
    if (doubanId) params.set('id', doubanId);
    if (kind) params.set('kind', kind);
    return `/api/image?${params.toString()}`;
  } catch { return ''; }
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
});

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

function keyOf(item) { return item?.key || `${item?.provider || 'item'}:${item?.id || titleOf(item)}`; }
function titleOf(item) { return item?.name || item?.title || '未命名'; }
function normalizeTitle(value = '') {
  return String(value).normalize('NFKC').toLowerCase().replace(/[\s\-_:：·•.，,()（）\[\]【】]/g, '').replace(/第?[一二三四五六七八九十0-9]+季$/u, '');
}
function canonicalItem(item) {
  return {
    key: keyOf(item), id: item?.id, provider: item?.provider, providerName: item?.providerName,
    name: titleOf(item), pic: item?.pic || item?.poster, remarks: item?.remarks,
    year: item?.year, type: item?.type, mediaType: item?.mediaType,
    sources: item?.sources, tmdb: item?.tmdb, douban: item?.douban,
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
  if (message && kind === 'warning') showNotice.timer = setTimeout(() => els.notice.classList.add('hidden'), 5200);
}

function formatTime(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

function setLoading(loading) {
  els.skeletons.classList.toggle('hidden', !loading);
  els.mediaGrid.classList.toggle('hidden', loading);
  els.loadMoreButton.classList.add('hidden');
  if (loading) {
    els.skeletons.innerHTML = Array.from({ length: 12 }, () => '<div class="skeleton"></div>').join('');
    els.emptyState.classList.add('hidden');
  }
}

function setActiveTab(view) {
  document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
}

function setCompactView(compact) { document.body.classList.toggle('compact-view', compact); }

function cancelPendingSearch() {
  searchSequence += 1;
  activeSearchController?.abort();
  activeSearchController = null;
}

function renderHero(item) {
  featuredItem = item || null;
  els.hero.classList.remove('poster-mode');
  els.heroArtwork.removeAttribute('src');
  for (const key of ['proxySrc', 'originalSrc', 'originalTried', 'proxyRetried']) delete els.heroArtwork.dataset[key];

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
    const original = safeImage(item.poster || item.pic || item.tmdb?.poster);
    els.heroArtwork.src = poster;
    els.heroArtwork.dataset.proxySrc = proxyImage(original, item);
    els.heroArtwork.dataset.originalSrc = original;
    els.heroArtwork.alt = titleOf(item);
  }

  els.heroTitle.textContent = titleOf(item);
  const rating = Number(item.rating || item.tmdb?.rating || item.douban?.rating || 0);
  const type = item.mediaType === 'tv' ? '剧集' : item.mediaType === 'movie' ? '电影' : item.type;
  els.heroMeta.innerHTML = [rating ? `★ ${rating.toFixed(1)}` : '', item.year, type]
    .filter(Boolean).map(value => `<span>${escapeHtml(value)}</span>`).join('');
  els.heroOverview.textContent = item.overview || item.tmdb?.overview || '';
}

function cardHtml(item, index, context = 'results') {
  const name = titleOf(item);
  const explicitBackdropSource = item.backdrop || item.tmdb?.backdrop || '';
  const portraitSource = item.pic || item.poster || item.tmdb?.poster || explicitBackdropSource;
  const explicitBackdrop = safeImage(explicitBackdropSource);
  const portraitVisual = safeImage(portraitSource);
  const preferPortrait = matchMedia('(max-width: 1024px)').matches;
  const visualSource = preferPortrait ? (portraitSource || explicitBackdropSource) : (explicitBackdropSource || portraitSource);
  const visual = safeImage(visualSource);
  const portraitOnly = !explicitBackdrop && Boolean(portraitVisual);
  const key = keyOf(item);
  const rating = Number(item.tmdb?.rating || item.rating || item.douban?.rating || 0);
  const canFavorite = ['results', 'saved'].includes(context) && item.provider;
  const favorite = canFavorite && store.isFavorite(key);
  const type = item.type || (item.mediaType === 'tv' ? '剧集' : item.mediaType === 'movie' ? '电影' : item.providerName || '');
  const primaryMeta = rating ? `★ ${rating.toFixed(1)}` : item.sourceCount > 1 ? `${item.sourceCount} 个片源` : '';
  const fallback = name.trim().slice(0, 1).toUpperCase() || 'C';
  const eager = context === 'home' && index < 6;
  const image = visual
    ? `<img loading="${eager ? 'eager' : 'lazy'}" decoding="async" fetchpriority="${eager && index < 2 ? 'auto' : 'low'}" referrerpolicy="no-referrer" ${imageAttributes(visualSource, fallback, item)} alt="${escapeHtml(name)}">`
    : `<div class="poster-fallback">${escapeHtml(fallback)}</div>`;
  const ambientImage = displayImage(visualSource, item);
  const posterStyle = portraitOnly && ambientImage ? ` style="--poster-ambient:url(&quot;${escapeHtml(ambientImage)}&quot;)"` : '';

  return `<article class="media-card" tabindex="0" role="button" aria-label="查看 ${escapeHtml(name)}" data-index="${index}" data-context="${context}">
    <div class="poster${portraitOnly ? ' poster-portrait-source' : ''}"${posterStyle}>${image}
      ${item.remarks ? `<span class="badge">${escapeHtml(item.remarks)}</span>` : rating ? `<span class="rating">★ ${rating.toFixed(1)}</span>` : ''}
      ${canFavorite ? `<button type="button" class="favorite-button ${favorite ? 'active' : ''}" data-favorite="${escapeHtml(key)}" aria-label="${favorite ? '取消收藏' : '收藏'}">${favorite ? '♥' : '+'}</button>` : ''}
      <div class="card-overlay"><strong>${escapeHtml(name)}</strong><div class="card-meta">${primaryMeta ? `<span class="match">${escapeHtml(primaryMeta)}</span>` : ''}${item.year ? `<span>${escapeHtml(item.year)}</span>` : ''}${type ? `<span>${escapeHtml(type)}</span>` : ''}</div></div>
    </div>
  </article>`;
}

function bindCards(container, items, context) {
  if (!container) return;
  const activate = async (card, event) => {
    const item = items[Number(card.dataset.index)];
    if (!item) return;
    const favoriteButton = event?.target?.closest?.('[data-favorite]');
    if (favoriteButton) {
      event.stopPropagation();
      toggleFavorite(item, favoriteButton);
      return;
    }
    if (['home', 'catalog'].includes(context) || !item.provider) {
      const query = titleOf(item);
      els.searchInput.value = query;
      await search(query);
    } else {
      await openDetail(item);
    }
  };
  container.onclick = event => {
    const card = event.target.closest?.('.media-card');
    if (card && container.contains(card)) activate(card, event);
  };
  container.onkeydown = event => {
    if (!['Enter', ' '].includes(event.key)) return;
    const card = event.target.closest?.('.media-card');
    if (!card || !container.contains(card)) return;
    event.preventDefault();
    activate(card, event);
  };
}

function broadKind(item) {
  const value = `${item.mediaType || ''} ${item.type || ''}`.toLowerCase();
  if (/动漫|动画|anime|animation/.test(value)) return 'animation';
  if (/综艺|variety|reality/.test(value)) return 'variety';
  if (/电视剧|剧集|连续剧|电视|国产剧|港台剧|日韩剧|欧美剧|series|\btv\b/.test(value)) return 'tv';
  if (/电影|movie|film|片$/.test(value.trim())) return 'movie';
  return 'other';
}

function itemSources(item) {
  if (Array.isArray(item.sources) && item.sources.length) return item.sources;
  return item.provider ? [{ provider: item.provider, providerName: item.providerName, id: item.id }] : [];
}

function filteredResults() {
  return currentResults.filter(item => {
    if (resultFilters.kind !== 'all' && broadKind(item) !== resultFilters.kind) return false;
    if (resultFilters.year !== 'all' && String(item.year || '') !== resultFilters.year) return false;
    if (resultFilters.source !== 'all' && !itemSources(item).some(source => source.provider === resultFilters.source)) return false;
    return true;
  });
}

function buildResultFilters() {
  const kinds = [...new Set(currentResults.map(broadKind))].filter(kind => kind !== 'other');
  const years = [...new Set(currentResults.map(item => String(item.year || '')).filter(year => /^(19|20)\d{2}$/.test(year)))].sort((a, b) => b.localeCompare(a));
  const sources = new Map();
  currentResults.flatMap(itemSources).forEach(source => sources.set(source.provider, source.providerName || source.provider));
  const kindLabels = { movie: '电影', tv: '剧集', animation: '动漫', variety: '综艺' };
  const useful = kinds.length > 1 || years.length > 1 || sources.size > 1;
  els.resultFilters.classList.toggle('hidden', !useful);
  if (!useful) {
    els.resultFilters.innerHTML = '';
    return;
  }
  els.resultFilters.innerHTML = `
    ${kinds.length > 1 ? `<div class="filter-group" data-filter-group="kind"><span class="filter-label">类型</span><button class="filter-chip ${resultFilters.kind === 'all' ? 'active' : ''}" data-value="all" type="button">全部</button>${kinds.map(kind => `<button class="filter-chip ${resultFilters.kind === kind ? 'active' : ''}" data-value="${kind}" type="button">${kindLabels[kind]}</button>`).join('')}</div>` : ''}
    ${years.length > 1 ? `<label class="filter-group"><span class="filter-label">年份</span><select class="filter-select" data-filter-select="year"><option value="all">全部年份</option>${years.slice(0, 20).map(year => `<option value="${year}" ${resultFilters.year === year ? 'selected' : ''}>${year}</option>`).join('')}</select></label>` : ''}
    ${sources.size > 1 ? `<label class="filter-group"><span class="filter-label">片源</span><select class="filter-select" data-filter-select="source"><option value="all">全部片源</option>${[...sources].map(([id, name]) => `<option value="${escapeHtml(id)}" ${resultFilters.source === id ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>` : ''}`;

  els.resultFilters.querySelectorAll('[data-filter-group="kind"] .filter-chip').forEach(button => button.addEventListener('click', () => {
    resultFilters.kind = button.dataset.value;
    visibleResultCount = PAGE_SIZE;
    buildResultFilters();
    renderResultBatch();
  }));
  els.resultFilters.querySelectorAll('[data-filter-select]').forEach(select => select.addEventListener('change', () => {
    resultFilters[select.dataset.filterSelect] = select.value;
    visibleResultCount = PAGE_SIZE;
    renderResultBatch();
  }));
}

function renderResultBatch() {
  const list = filteredResults();
  const visible = list.slice(0, visibleResultCount);
  els.resultCount.textContent = list.length ? `${list.length} 个结果` : '';
  els.emptyState.classList.toggle('hidden', list.length > 0);
  els.mediaGrid.innerHTML = visible.map((item, index) => cardHtml(item, index, currentResultContext)).join('');
  bindCards(els.mediaGrid, visible, currentResultContext);
  els.loadMoreButton.classList.toggle('hidden', visible.length >= list.length);
  els.loadMoreButton.textContent = `显示更多（${visible.length}/${list.length}）`;
}

function render(items, title, kicker, options = {}) {
  currentResults = Array.isArray(items) ? items : [];
  currentResultTitle = title;
  currentResultKicker = kicker;
  currentResultContext = options.context || 'results';
  visibleResultCount = PAGE_SIZE;
  resultFilters = { kind: 'all', year: 'all', source: 'all' };
  setCompactView(true);
  els.categoryNav.classList.add('hidden');
  els.resultsSection.classList.remove('hidden');
  els.homeSections.classList.add('hidden');
  els.sectionTitle.textContent = title;
  els.sectionKicker.textContent = kicker;
  if (options.filters === false) els.resultFilters.classList.add('hidden');
  else buildResultFilters();
  renderResultBatch();
}

function renderCategoryNav(activeId = '') {
  if (!homeSectionsData.length) {
    els.categoryNav.classList.add('hidden');
    return;
  }
  els.categoryNav.classList.remove('hidden');
  els.categoryNav.innerHTML = `<button class="category-chip ${activeId ? '' : 'active'}" data-category="" type="button">全部</button>${homeSectionsData.map(section => `<button class="category-chip ${activeId === section.id ? 'active' : ''}" data-category="${escapeHtml(section.id)}" type="button">${escapeHtml(section.title)}</button>`).join('')}`;
  els.categoryNav.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.category;
    if (!id) navigate('/');
    else navigate(`/category/${encodeURIComponent(id)}`);
  }));
}

function renderHome(sections) {
  homeSectionsData = Array.isArray(sections) ? sections : [];
  currentView = 'home';
  setCompactView(false);
  setActiveTab('home');
  els.resultsSection.classList.add('hidden');
  els.homeSections.classList.remove('hidden');
  renderCategoryNav('');
  if (!homeSectionsData.length) {
    renderHero(null);
    els.homeSections.innerHTML = '<div class="empty-state"><div class="empty-icon">C</div><h3>首页暂无内容</h3><p>可以直接使用上方搜索。</p></div>';
    return;
  }
  const firstSection = homeSectionsData.find(section => section.items?.length);
  renderHero(firstSection?.items?.[0]);
  els.homeSections.innerHTML = homeSectionsData.map((section, sectionIndex) => `<section class="catalog-section">
    <div class="section-heading"><h2>${escapeHtml(section.title)}</h2>
      <div class="row-controls" aria-label="滚动片单"><button type="button" class="row-control" data-row="${sectionIndex}" data-dir="-1" aria-label="向左">‹</button><button type="button" class="row-control" data-row="${sectionIndex}" data-dir="1" aria-label="向右">›</button></div>
    </div>
    <div class="media-row" data-section="${sectionIndex}">${(section.items || []).map((item, index) => cardHtml(item, index, 'home')).join('')}</div>
  </section>`).join('');
  homeSectionsData.forEach((section, index) => bindCards(els.homeSections.querySelector(`[data-section="${index}"]`), section.items || [], 'home'));
  els.homeSections.querySelectorAll('.row-control').forEach(button => button.addEventListener('click', () => {
    const row = els.homeSections.querySelector(`[data-section="${button.dataset.row}"]`);
    row?.scrollBy({ left: Number(button.dataset.dir) * Math.max(row.clientWidth * .82, 320), behavior: 'smooth' });
  }));
}

function renderCategory(section) {
  if (!section) {
    render([], '分类不存在', 'CATEGORY', { context: 'catalog', filters: false });
    return;
  }
  currentView = 'category';
  setActiveTab('home');
  renderCategoryNav(section.id);
  render(section.items || [], section.title, section.kicker || 'CATEGORY', { context: 'catalog', filters: false });
  els.categoryNav.classList.remove('hidden');
  renderCategoryNav(section.id);
}

function toggleFavorite(item, button) {
  const active = store.toggleFavorite(canonicalItem(item));
  button.classList.toggle('active', active);
  button.textContent = active ? '♥' : '+';
  button.setAttribute('aria-label', active ? '取消收藏' : '收藏');
  if (currentView === 'favorites') renderSavedView('favorites', { push: false });
}

async function loadHome({ render = true } = {}) {
  const payload = await api.home();
  homeSectionsData = payload.sections || [];
  if (render) renderHome(homeSectionsData);
  if (payload.notice) showNotice(payload.notice, 'warning');
  return payload;
}

async function search(query, options = {}) {
  const value = String(query || '').trim();
  if (!value) return;
  if (options.push !== false) navigate(`/search?q=${encodeURIComponent(value)}`, { apply: false, state: { view: 'search' } });
  const sequence = ++searchSequence;
  activeSearchController?.abort();
  const controller = new AbortController();
  activeSearchController = controller;
  currentSearchQuery = value;
  currentView = 'search';
  setActiveTab('home');
  setCompactView(true);
  showNotice('');
  setLoading(true);
  els.categoryNav.classList.add('hidden');
  els.resultsSection.classList.remove('hidden');
  els.homeSections.classList.add('hidden');
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
  try {
    const payload = await api.search(value, controller.signal);
    if (sequence !== searchSequence) return;
    render(payload.items || [], `“${value}”`, 'SEARCH RESULTS', { context: 'results', filters: true });
    if (payload.errors?.length) showNotice(`部分数据源不可用：${payload.errors.map(error => error.provider).join('、')}`, 'warning');
  } catch (error) {
    if (sequence !== searchSequence || error?.name === 'AbortError') return;
    render([], '搜索失败', 'ERROR', { context: 'results', filters: false });
    showNotice(error.message, 'error');
  } finally {
    if (sequence === searchSequence) {
      setLoading(false);
      if (activeSearchController === controller) activeSearchController = null;
    }
  }
}

function sortedSources(item, currentProvider = '') {
  const sources = itemSources(item);
  return [...sources].sort((a, b) => {
    if (a.provider === currentProvider) return -1;
    if (b.provider === currentProvider) return 1;
    const score = store.sourceScore(b.provider) - store.sourceScore(a.provider);
    if (score) return score;
    return Number(a.latency || 99999) - Number(b.latency || 99999);
  });
}

function episodeIdentity(name, index) {
  const text = String(name || '').normalize('NFKC').toLowerCase().trim();
  const match = text.match(/(?:第\s*)?(\d{1,4})(?:\s*[集话期]|\s*$)/) || text.match(/(?:ep(?:isode)?\s*)(\d{1,4})/i);
  if (match) return `n:${Number(match[1])}`;
  const normalized = text.replace(/[\s\-_:：·•.，,()（）\[\]【】]/g, '').replace(/第|集|话|期|episode|ep/g, '');
  return normalized ? `t:${normalized}` : `i:${index}`;
}

function candidatesForDetail(detail, target, preferred = {}) {
  const candidates = [];
  const targetIdentity = target.identity || episodeIdentity(target.name, target.index);
  (detail.lines || []).forEach((line, lineIndex) => {
    (line.episodes || []).forEach((episode, episodeIndex) => {
      const identity = episodeIdentity(episode.name, episodeIndex);
      const exactPreferred = lineIndex === preferred.lineIndex && episodeIndex === preferred.episodeIndex;
      const sameEpisode = identity === targetIdentity || (!target.name && episodeIndex === target.index);
      if (!exactPreferred && !sameEpisode) return;
      const url = episode.playbackUrl || episode.url;
      if (!url) return;
      candidates.push({
        detail, episode, lineIndex, episodeIndex,
        lineName: line.name || `线路 ${lineIndex + 1}`,
        provider: detail.provider,
        providerName: detail.providerName,
        url,
        priority: exactPreferred ? -1000 : lineIndex,
      });
    });
  });
  if (!candidates.length) {
    const fallbackLine = detail.lines?.[0];
    const fallbackEpisode = fallbackLine?.episodes?.[target.index];
    if (fallbackEpisode) candidates.push({
      detail, episode: fallbackEpisode, lineIndex: 0, episodeIndex: target.index,
      lineName: fallbackLine.name || '线路 1', provider: detail.provider, providerName: detail.providerName,
      url: fallbackEpisode.playbackUrl || fallbackEpisode.url, priority: 999,
    });
  }
  return candidates.sort((a, b) => a.priority - b.priority);
}

async function openDetail(item, sourceOverride = null, options = {}) {
  const sequence = ++detailSequence;
  const source = sourceOverride || { provider: item.provider, id: item.id, providerName: item.providerName };
  if (!source.provider || !source.id) {
    await search(titleOf(item));
    return;
  }
  if (options.push !== false) navigate(detailPath(source.provider, source.id), { apply: false, state: { overlay: 'detail', from: location.pathname + location.search } });
  els.detailContent.innerHTML = '<div class="empty-state"><div class="empty-icon">C</div><p>正在加载详情…</p></div>';
  if (!els.detailDialog.open) els.detailDialog.showModal();

  try {
    const payload = await api.detail(source.provider, source.id);
    if (sequence !== detailSequence) return null;
    const detail = payload.item;
    const canonicalKey = item.key || detail.key;
    detail.canonicalKey = canonicalKey;
    const mergedItem = { ...item, provider: detail.provider, id: detail.id, providerName: detail.providerName, key: canonicalKey };
    currentDetailContext = { item: mergedItem, detail, source };
    renderDetail(mergedItem, detail);
    return detail;
  } catch (error) {
    if (sequence !== detailSequence) return null;
    els.detailContent.innerHTML = `<div class="empty-state"><div class="empty-icon">!</div><h3>详情加载失败</h3><p>${escapeHtml(error.message)}</p><button class="primary-button" id="retryDetail">重试</button></div>`;
    $('#retryDetail')?.addEventListener('click', () => openDetail(item, source, { push: false }));
    return null;
  }
}

function renderDetail(item, detail) {
  const poster = safeImage(detail.pic);
  const cover = safeImage(detail.backdrop || detail.tmdb?.backdrop || detail.pic);
  const lines = detail.lines || [];
  const historyItem = store.progress(detail.canonicalKey || item.key || detail.key);
  const preferredLine = Number(historyItem?.lineIndex ?? 0);
  const preferredEpisode = Number(historyItem?.episodeIndex ?? 0);
  const allEpisodes = lines.flatMap((line, lineIndex) => (line.episodes || []).map((episode, episodeIndex) => ({ episode, lineIndex, episodeIndex })));
  const firstPlayable = allEpisodes.find(entry => entry.lineIndex === preferredLine && entry.episodeIndex === preferredEpisode) || allEpisodes[0];
  const description = String(detail.content || '').trim();
  const metaValues = [
    detail.tmdb?.rating ? `★ ${Number(detail.tmdb.rating).toFixed(1)}` : '',
    detail.douban?.rating ? `豆瓣 ${Number(detail.douban.rating).toFixed(1)}` : '',
    detail.year, detail.type, detail.area, detail.lang,
  ].filter(Boolean);
  const sources = sortedSources(item, detail.provider);
  const sourceButtons = sources.map(candidate => `<button class="source-choice ${candidate.provider === detail.provider ? 'active' : ''}" data-provider="${escapeHtml(candidate.provider)}" data-id="${escapeHtml(candidate.id)}">${escapeHtml(candidate.providerName || candidate.provider)}${candidate.latency ? `<small>${candidate.latency}ms</small>` : ''}</button>`).join('');
  const credits = [
    detail.director ? `<p><span>导演</span>${escapeHtml(detail.director)}</p>` : '',
    detail.actors ? `<p><span>演员</span>${escapeHtml(detail.actors)}</p>` : '',
  ].filter(Boolean).join('');
  const lineHtml = lines.map((line, lineIndex) => {
    const rawName = String(line.name || '').trim();
    const lineName = lines.length === 1 ? '选集' : (/m3u8|线路|line|source/i.test(rawName) ? `线路 ${lineIndex + 1}` : rawName || `线路 ${lineIndex + 1}`);
    return `<section class="episode-block">
      <div class="episode-heading"><h3>${escapeHtml(lineName)}</h3><span>${line.episodes.length} 集</span></div>
      <div class="episodes">${line.episodes.map((episode, episodeIndex) => `<button class="episode ${lineIndex === preferredLine && episodeIndex === preferredEpisode ? 'is-current' : ''}" data-line="${lineIndex}" data-episode="${episodeIndex}">${escapeHtml(episode.name || `第${episodeIndex + 1}集`)}${episode.proxied ? '<i>代理</i>' : ''}</button>`).join('')}</div>
    </section>`;
  }).join('');

  els.detailContent.innerHTML = `<section class="detail-masthead">
    ${cover ? `<img class="detail-cover" referrerpolicy="no-referrer" ${imageAttributes(detail.backdrop || detail.tmdb?.backdrop || detail.pic, 'C', detail)} alt="">` : '<div class="detail-cover-fallback">C</div>'}
    <div class="detail-masthead-shade"></div>
  </section>
  <div class="detail-main">
    <div class="detail-title-row">
      ${poster ? `<img class="detail-thumb" referrerpolicy="no-referrer" ${imageAttributes(detail.pic, 'C', detail)} alt="${escapeHtml(detail.name)}">` : ''}
      <div class="detail-title-copy"><h2>${escapeHtml(detail.name)}</h2><div class="detail-meta">${metaValues.map(value => `<span>${escapeHtml(value)}</span>`).join('')}</div></div>
    </div>
    ${firstPlayable ? `<button class="detail-primary-play" type="button" data-line="${firstPlayable.lineIndex}" data-episode="${firstPlayable.episodeIndex}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" fill="currentColor"/></svg>${historyItem?.position > 5 ? `继续播放 ${formatTime(historyItem.position)}` : `播放${escapeHtml(firstPlayable.episode.name || '第1集')}`}</button>` : ''}
    ${sourceButtons ? `<div class="detail-source-bar"><span>片源</span><div class="source-choices">${sourceButtons}</div></div>` : ''}
    ${description ? `<div class="detail-overview-wrap"><p class="detail-overview ${description.length > 110 ? 'collapsed' : ''}">${escapeHtml(description)}</p>${description.length > 110 ? '<button class="detail-more" type="button">展开</button>' : ''}</div>` : ''}
    ${credits ? `<details class="detail-credits"><summary>演职员与信息</summary>${credits}</details>` : ''}
    ${lineHtml || '<div class="episode-block"><p class="muted">此数据源没有返回可播放条目。</p></div>'}
  </div>`;

  els.detailContent.querySelectorAll('.source-choice').forEach(button => button.addEventListener('click', () => {
    openDetail(item, { provider: button.dataset.provider, id: button.dataset.id }, { push: true });
  }));
  els.detailContent.querySelectorAll('.episode, .detail-primary-play').forEach(button => button.addEventListener('click', () => {
    const lineIndex = Number(button.dataset.line);
    const episodeIndex = Number(button.dataset.episode);
    const episode = lines[lineIndex]?.episodes?.[episodeIndex];
    if (episode) openPlayer(detail, episode, { item, lineIndex, episodeIndex, push: true });
  }));
  els.detailContent.querySelector('.detail-more')?.addEventListener('click', event => {
    const overview = els.detailContent.querySelector('.detail-overview');
    const collapsed = overview?.classList.toggle('collapsed');
    event.currentTarget.textContent = collapsed ? '展开' : '收起';
  });
}

function resetCandidatePool(playback, includeCurrent = false) {
  const current = playback.currentCandidate;
  playback.candidateQueue = candidatesForDetail(playback.baseDetail, playback.target, playback.preferred);
  if (includeCurrent && current) playback.candidateQueue.unshift(current);
  playback.alternativeSources = sortedSources(playback.sourceItem, playback.baseDetail.provider)
    .filter(source => !(source.provider === playback.baseDetail.provider && String(source.id) === String(playback.baseDetail.id)));
  playback.alternativeCursor = 0;
  playback.attemptedUrls.clear();
}

async function nextPlaybackCandidate(playback) {
  while (true) {
    while (playback.candidateQueue.length) {
      const candidate = playback.candidateQueue.shift();
      if (!candidate?.url || playback.attemptedUrls.has(candidate.url)) continue;
      return candidate;
    }
    const source = playback.alternativeSources[playback.alternativeCursor++];
    if (!source) return null;
    try {
      const payload = await api.detail(source.provider, source.id);
      const detail = payload.item;
      detail.canonicalKey = playback.canonicalKey;
      playback.candidateQueue.push(...candidatesForDetail(detail, playback.target, {}));
    } catch (error) {
      store.recordSourceFailure(source.provider);
      console.warn('备用片源详情加载失败', source.provider, error);
    }
  }
}

function setPlaybackStatus(message = '', state = '') {
  els.playbackStatus.textContent = message;
  els.playbackStatus.className = `playback-status ${state}`;
}

function populateSubtitles(subtitles) {
  const list = Array.isArray(subtitles) ? subtitles : [];
  els.subtitleSelect.innerHTML = '<option value="">关闭</option>' + list.map((subtitle, index) => `<option value="${index}">${escapeHtml(subtitle.name)} · ${escapeHtml(subtitle.lang || '')}</option>`).join('');
  els.subtitleSelect._items = list;
  els.subtitleFile.value = '';
}

function updateEpisodeControls() {
  if (!currentPlayback?.currentCandidate) {
    els.playerPrev.disabled = true;
    els.playerNext.disabled = true;
    return;
  }
  const { detail, lineIndex, episodeIndex } = currentPlayback.currentCandidate;
  const episodes = detail.lines?.[lineIndex]?.episodes || [];
  els.playerPrev.disabled = episodeIndex <= 0;
  els.playerNext.disabled = episodeIndex >= episodes.length - 1;
}

function mediaSessionFor(candidate) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: candidate.detail.name || 'Cactus TV',
      artist: candidate.episode.name || '',
      artwork: candidate.detail.pic ? [{ src: displayImage(candidate.detail.pic, candidate.detail) }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => els.player.play());
    navigator.mediaSession.setActionHandler('pause', () => els.player.pause());
    navigator.mediaSession.setActionHandler('seekbackward', event => { els.player.currentTime = Math.max(0, els.player.currentTime - (event.seekOffset || 10)); });
    navigator.mediaSession.setActionHandler('seekforward', event => { els.player.currentTime = Math.min(els.player.duration || Infinity, els.player.currentTime + (event.seekOffset || 10)); });
    navigator.mediaSession.setActionHandler('previoustrack', () => playRelativeEpisode(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => playRelativeEpisode(1));
  } catch {}
}

async function startCandidate(playback, candidate, startAt) {
  if (playback.sequence !== playbackSequence || !els.playerDialog.open) throw new DOMException('播放已取消', 'AbortError');
  playback.currentCandidate = candidate;
  playback.detail = candidate.detail;
  playback.episode = candidate.episode;
  playback.playUrl = candidate.url;
  playback.starting = true;
  const rate = Number(els.player.playbackRate || 1);
  playerUI.reset();
  els.player.playbackRate = rate;
  els.playerTitle.textContent = candidate.detail.name;
  els.playerSubtitle.textContent = `${candidate.episode.name || '播放'} · ${candidate.providerName || candidate.provider} / ${candidate.lineName}`;
  populateSubtitles(candidate.detail.subtitles || []);
  updateEpisodeControls();
  mediaSessionFor(candidate);
  const attemptNumber = playback.attemptedUrls.size + 1;
  setPlaybackStatus(attemptNumber > 1 ? `正在尝试备用线路：${candidate.providerName || candidate.provider} · ${candidate.lineName}` : `${candidate.providerName || candidate.provider} · ${candidate.lineName}`, attemptNumber > 1 ? 'switching' : '');
  playback.attemptedUrls.add(candidate.url);
  try {
    await playStream(els.player, candidate.url, settings.preferNativeHls, startAt);
    if (playback.sequence !== playbackSequence) return;
    playback.starting = false;
    playback.lastSync = Date.now();
    store.recordSourceSuccess(candidate.provider);
    setPlaybackStatus(`${candidate.providerName || candidate.provider} · ${candidate.lineName}`, 'ready');
    replaceWatchRoute(candidate, playback);
  } catch (error) {
    playback.starting = false;
    store.recordSourceFailure(candidate.provider);
    throw error;
  }
}

async function attemptPlayback(startAt = 0, options = {}) {
  const playback = currentPlayback;
  if (!playback || playback.failureHandling || playback.sequence !== playbackSequence) return false;
  playback.failureHandling = true;
  let lastError = options.reason || null;
  try {
    while (playback.sequence === playbackSequence && els.playerDialog.open) {
      const candidate = await nextPlaybackCandidate(playback);
      if (!candidate) break;
      try {
        await startCandidate(playback, candidate, startAt);
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        lastError = error;
        if (!settings.autoFailover && !options.forceFailover) break;
      }
    }
    const message = lastError?.message || '所有可用线路均播放失败';
    setPlaybackStatus('没有可用的备用线路', '');
    playerUI.showError(new Error(`${message}。已尝试当前影片的可用线路和片源。`));
    return false;
  } finally {
    playback.failureHandling = false;
  }
}

async function openPlayer(detail, episode, options = {}) {
  cancelNextEpisode();
  const sequence = ++playbackSequence;
  const sourceItem = options.item || currentDetailContext?.item || detail;
  const lineIndex = Number(options.lineIndex ?? 0);
  const episodeIndex = Number(options.episodeIndex ?? 0);
  const canonicalKey = detail.canonicalKey || sourceItem.key || detail.key;
  const historyItem = store.progress(canonicalKey);
  const sameEpisode = historyItem && (
    (Number(historyItem.episodeIndex) === episodeIndex && Number(historyItem.lineIndex) === lineIndex)
    || episodeIdentity(historyItem.episodeName, Number(historyItem.episodeIndex || 0)) === episodeIdentity(episode.name, episodeIndex)
  );
  const resumeAt = options.resumeAt ?? (settings.resumePlayback && sameEpisode ? Number(historyItem.position || 0) : 0);
  els.resumeHint.textContent = resumeAt > 5 ? `将从 ${formatTime(resumeAt)} 继续` : '';
  if (!els.playerDialog.open) els.playerDialog.showModal();

  currentPlayback = {
    sequence,
    canonicalKey,
    sourceItem: { ...sourceItem, key: canonicalKey },
    item: { ...canonicalItem(sourceItem), key: canonicalKey },
    baseDetail: detail,
    detail,
    episode,
    preferred: { lineIndex, episodeIndex },
    target: { name: episode.name || '', index: episodeIndex, identity: episodeIdentity(episode.name, episodeIndex) },
    candidateQueue: [], alternativeSources: [], alternativeCursor: 0,
    attemptedUrls: new Set(), currentCandidate: null,
    failureHandling: false, starting: false, lastSync: 0,
  };
  resetCandidatePool(currentPlayback);
  playerUI.setRetry(() => {
    if (!currentPlayback) return;
    const retryAt = Number.isFinite(els.player.currentTime) ? els.player.currentTime : resumeAt;
    resetCandidatePool(currentPlayback, true);
    attemptPlayback(retryAt, { forceFailover: true });
  });
  requestAnimationFrame(() => playerUI.focus());
  if (options.push !== false) {
    const path = watchPath(detail.provider, detail.id, lineIndex, episodeIndex);
    navigate(path, { apply: false, replace: options.replaceRoute === true, state: { overlay: 'watch', fromDetail: els.detailDialog.open } });
  }
  if (settings.recordHistory && historyItem) saveHistory(resumeAt, Number(historyItem.duration || 0));
  await attemptPlayback(resumeAt);
}

function saveHistory(position = els.player.currentTime || 0, duration = els.player.duration || 0) {
  if (!currentPlayback || !settings.recordHistory) return;
  const candidate = currentPlayback.currentCandidate;
  const episode = candidate?.episode || currentPlayback.episode;
  const record = {
    ...currentPlayback.item,
    provider: candidate?.detail?.provider || currentPlayback.detail.provider,
    providerName: candidate?.detail?.providerName || currentPlayback.detail.providerName,
    id: candidate?.detail?.id || currentPlayback.detail.id,
    key: currentPlayback.canonicalKey,
    sources: currentPlayback.sourceItem.sources,
    episodeName: episode?.name || '',
    lineIndex: candidate?.lineIndex ?? currentPlayback.preferred.lineIndex,
    episodeIndex: candidate?.episodeIndex ?? currentPlayback.preferred.episodeIndex,
    sourceName: candidate?.providerName || candidate?.provider || '',
    url: candidate?.url || currentPlayback.playUrl || '',
    position,
    duration,
  };
  store.addHistory(record);
}

function relativeEpisode(delta) {
  const candidate = currentPlayback?.currentCandidate;
  if (!candidate) return null;
  const episodes = candidate.detail.lines?.[candidate.lineIndex]?.episodes || [];
  const nextIndex = candidate.episodeIndex + delta;
  const episode = episodes[nextIndex];
  if (!episode) return null;
  return { detail: candidate.detail, episode, lineIndex: candidate.lineIndex, episodeIndex: nextIndex };
}

function playRelativeEpisode(delta, options = {}) {
  const target = relativeEpisode(delta);
  if (!target || !currentPlayback) return false;
  const item = currentPlayback.sourceItem;
  openPlayer(target.detail, target.episode, {
    item,
    lineIndex: target.lineIndex,
    episodeIndex: target.episodeIndex,
    push: true,
    replaceRoute: options.replaceRoute === true,
    resumeAt: 0,
  });
  return true;
}

function cancelNextEpisode() {
  clearInterval(nextEpisodeTimer);
  nextEpisodeTimer = 0;
  nextEpisodeDeadline = 0;
  nextEpisodeTarget = null;
  els.nextEpisodePrompt.classList.add('hidden');
}

function showNextEpisodePrompt() {
  const target = relativeEpisode(1);
  if (!target || !settings.autoNext) return;
  nextEpisodeTarget = target;
  nextEpisodeDeadline = Date.now() + 5000;
  els.nextEpisodePrompt.classList.remove('hidden');
  const update = () => {
    const seconds = Math.max(0, Math.ceil((nextEpisodeDeadline - Date.now()) / 1000));
    els.nextEpisodeText.textContent = `${target.episode.name || `第${target.episodeIndex + 1}集`} · ${seconds} 秒后播放`;
    if (seconds <= 0) {
      cancelNextEpisode();
      playRelativeEpisode(1, { replaceRoute: true });
    }
  };
  update();
  nextEpisodeTimer = setInterval(update, 250);
}

function renderSavedView(view, options = {}) {
  cancelPendingSearch();
  currentView = view;
  setActiveTab(view);
  showNotice('');
  const list = view === 'favorites' ? store.favorites() : store.history();
  render(list, view === 'favorites' ? '我的片单' : '继续观看', 'SAVED ON THIS DEVICE', { context: 'saved', filters: true });
  if (options.push !== false) navigate(`/${view}`, { apply: false, state: { view } });
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSearch() {
  document.body.classList.add('search-open');
  requestAnimationFrame(() => els.searchInput.focus());
}
function closeSearch() { document.body.classList.remove('search-open'); }

function detailPath(provider, id) { return `/detail/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`; }
function watchPath(provider, id, lineIndex, episodeIndex) {
  return `/watch/${encodeURIComponent(provider)}/${encodeURIComponent(id)}?line=${Number(lineIndex) || 0}&episode=${Number(episodeIndex) || 0}`;
}

function parseRoute() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const detail = path.match(/^\/detail\/([^/]+)\/([^/]+)$/);
  if (detail) return { type: 'detail', provider: decodeURIComponent(detail[1]), id: decodeURIComponent(detail[2]) };
  const watch = path.match(/^\/watch\/([^/]+)\/([^/]+)$/);
  if (watch) {
    const params = new URLSearchParams(location.search);
    return { type: 'watch', provider: decodeURIComponent(watch[1]), id: decodeURIComponent(watch[2]), line: Number(params.get('line') || 0), episode: Number(params.get('episode') || 0) };
  }
  const category = path.match(/^\/category\/([^/]+)$/);
  if (category) return { type: 'category', id: decodeURIComponent(category[1]) };
  if (path === '/search') return { type: 'search', query: new URLSearchParams(location.search).get('q') || '' };
  if (path === '/favorites') return { type: 'favorites' };
  if (path === '/history') return { type: 'history' };
  return { type: 'home' };
}

function navigate(url, options = {}) {
  const state = { cactus: true, direct: false, ...(options.state || {}) };
  if (options.replace) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
  if (options.apply !== false) applyRoute();
}

function replaceWatchRoute(candidate, playback) {
  if (!location.pathname.startsWith('/watch/')) return;
  const state = history.state || { cactus: true, direct: false, overlay: 'watch' };
  history.replaceState(state, '', watchPath(candidate.detail.provider, candidate.detail.id, candidate.lineIndex, candidate.episodeIndex));
  playback.preferred = { lineIndex: candidate.lineIndex, episodeIndex: candidate.episodeIndex };
}

function closePlayerRoute() {
  cancelNextEpisode();
  if (history.state?.fromDetail && !history.state?.direct) history.back();
  else if (currentPlayback?.currentCandidate) {
    const candidate = currentPlayback.currentCandidate;
    navigate(detailPath(candidate.detail.provider, candidate.detail.id), { replace: true });
  } else navigate('/', { replace: true });
}

function closeDetailRoute() {
  if (!history.state?.direct && history.state?.overlay === 'detail') history.back();
  else navigate('/', { replace: true });
}

async function applyRoute() {
  if (routeApplying) return;
  routeApplying = true;
  const route = parseRoute();
  try {
    if (route.type !== 'watch' && els.playerDialog.open) els.playerDialog.close();
    if (!['detail', 'watch'].includes(route.type) && els.detailDialog.open) els.detailDialog.close();

    if (route.type === 'home') {
      cancelPendingSearch();
      if (homeSectionsData.length) renderHome(homeSectionsData);
      else await loadHome({ render: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (route.type === 'search') {
      if (route.query) {
        els.searchInput.value = route.query;
        await search(route.query, { push: false, scroll: false });
      } else openSearch();
    } else if (route.type === 'favorites' || route.type === 'history') {
      renderSavedView(route.type, { push: false, scroll: false });
    } else if (route.type === 'category') {
      if (!homeSectionsData.length) await loadHome({ render: false });
      renderCategory(homeSectionsData.find(section => section.id === route.id));
    } else if (route.type === 'detail') {
      await openDetail({ provider: route.provider, id: route.id, key: `${route.provider}:${route.id}` }, null, { push: false });
    } else if (route.type === 'watch') {
      const payload = await api.detail(route.provider, route.id);
      const detail = payload.item;
      const lineIndex = Math.max(0, Math.min(route.line, (detail.lines || []).length - 1));
      const episodes = detail.lines?.[lineIndex]?.episodes || [];
      const episodeIndex = Math.max(0, Math.min(route.episode, episodes.length - 1));
      const episode = episodes[episodeIndex];
      if (!episode) throw new Error('该播放地址没有可用分集');
      await openPlayer(detail, episode, {
        item: { provider: detail.provider, providerName: detail.providerName, id: detail.id, name: detail.name, pic: detail.pic, key: detail.key },
        lineIndex, episodeIndex, push: false,
      });
    }
  } catch (error) {
    showNotice(error.message || '页面加载失败', 'error');
  } finally {
    routeApplying = false;
  }
}

els.loadMoreButton.addEventListener('click', () => {
  visibleResultCount += PAGE_SIZE;
  renderResultBatch();
});

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
els.brand.addEventListener('click', event => { event.preventDefault(); navigate('/'); });
els.heroPlayButton.addEventListener('click', () => {
  const query = featuredItem ? titleOf(featuredItem) : els.searchInput.value.trim();
  if (query) {
    els.searchInput.value = query;
    search(query);
  } else openSearch();
});
els.heroInfoButton.addEventListener('click', () => els.homeSections.querySelector('.catalog-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', () => {
  const view = tab.dataset.view;
  navigate(view === 'home' ? '/' : `/${view}`);
}));

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
  const id = button.dataset.close;
  if (id === 'playerDialog') closePlayerRoute();
  else if (id === 'detailDialog') closeDetailRoute();
  else document.getElementById(id)?.close();
}));

els.detailDialog.addEventListener('cancel', event => { event.preventDefault(); closeDetailRoute(); });
els.playerDialog.addEventListener('cancel', event => { event.preventDefault(); closePlayerRoute(); });
[els.detailDialog, els.playerDialog, els.settingsDialog].forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  if (dialog === els.playerDialog) closePlayerRoute();
  else if (dialog === els.detailDialog) closeDetailRoute();
  else dialog.close();
}));

els.settingsButton.addEventListener('click', () => els.settingsDialog.showModal());
[els.historyToggle, els.nativeHlsToggle, els.resumeToggle, els.failoverToggle, els.autoNextToggle].forEach(input => input.addEventListener('change', () => {
  settings = {
    recordHistory: els.historyToggle.checked,
    preferNativeHls: els.nativeHlsToggle.checked,
    resumePlayback: els.resumeToggle.checked,
    autoFailover: els.failoverToggle.checked,
    autoNext: els.autoNextToggle.checked,
  };
  store.saveSettings(settings);
  if (!settings.autoNext) cancelNextEpisode();
}));

els.subtitleSelect.addEventListener('change', async () => {
  try {
    const item = els.subtitleSelect.value === '' ? null : els.subtitleSelect._items[Number(els.subtitleSelect.value)];
    await loadSubtitle(els.player, item);
  } catch (error) { toast(error.message, 'error'); }
});
els.subtitleFile.addEventListener('change', async () => {
  const file = els.subtitleFile.files?.[0];
  if (!file) return;
  try {
    const subtitle = await localSubtitle(file);
    await loadSubtitle(els.player, subtitle);
    toast('本地字幕已加载');
  } catch (error) { toast(error.message, 'error'); }
});

els.playerPrev.addEventListener('click', () => playRelativeEpisode(-1));
els.playerNext.addEventListener('click', () => playRelativeEpisode(1));
els.playerSwitchSource.addEventListener('click', () => {
  if (!currentPlayback) return;
  const position = Number.isFinite(els.player.currentTime) ? els.player.currentTime : 0;
  stopStream(els.player);
  attemptPlayback(position, { forceFailover: true, reason: new Error('手动切换线路') });
});
els.nextEpisodeNow.addEventListener('click', () => {
  cancelNextEpisode();
  playRelativeEpisode(1, { replaceRoute: true });
});
els.nextEpisodeCancel.addEventListener('click', cancelNextEpisode);

els.player.addEventListener('timeupdate', () => {
  if (!currentPlayback || Date.now() - currentPlayback.lastSync < 15000) return;
  currentPlayback.lastSync = Date.now();
  saveHistory();
});
els.player.addEventListener('ended', () => {
  saveHistory(els.player.duration || els.player.currentTime || 0, els.player.duration || 0);
  showNextEpisodePrompt();
});
els.player.addEventListener('cactus:error', event => {
  const playback = currentPlayback;
  if (!playback || playback.starting || playback.failureHandling || playback.sequence !== playbackSequence) return;
  const position = Number.isFinite(els.player.currentTime) ? els.player.currentTime : 0;
  if (settings.autoFailover) attemptPlayback(position, { reason: event.detail.error });
});

els.playerDialog.addEventListener('close', () => {
  playbackSequence += 1;
  cancelNextEpisode();
  saveHistory();
  playerUI.setRetry(null);
  stopStream(els.player);
  currentPlayback = null;
  setPlaybackStatus('');
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = null; } catch {}
  }
});

window.addEventListener('pagehide', () => saveHistory());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveHistory(); });
window.addEventListener('popstate', applyRoute);
window.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('search-open')) closeSearch(); });

let scrollFrame = 0;
window.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    els.topbar.classList.toggle('scrolled', window.scrollY > 28);
    scrollFrame = 0;
  });
}, { passive: true });
window.addEventListener('unhandledrejection', event => {
  if (event.reason?.name === 'AbortError') return;
  console.error(event.reason);
  toast(event.reason?.message || '页面发生未处理错误', 'error');
});

(async function init() {
  renderHero(null);
  if (!history.state?.cactus) history.replaceState({ cactus: true, direct: true }, '', location.href);
  try {
    const health = await api.health();
    const siteName = health.siteName || 'Cactus TV';
    const brandBase = siteName.replace(/\s*TV\s*$/i, '').trim() || 'Cactus';
    els.brandName.textContent = brandBase.toUpperCase();
    els.footerName.textContent = siteName;
    document.title = siteName;
    if (health.tmdbReady) els.metadataCredit.innerHTML = '<a class="footer-link" href="https://www.themoviedb.org" target="_blank" rel="noreferrer">Metadata by TMDB</a>';
    else els.metadataCredit.textContent = '影片资料来自豆瓣';
    els.sourcePills.innerHTML = (health.providers || []).map(provider => `<span class="source-pill ${provider.proxyEnabled ? 'proxied' : ''}">${escapeHtml(provider.name)}</span>`).join('');
    if (!health.providers?.length) showNotice('尚未配置数据源。请打开 /admin.html 添加兼容接口。', 'warning');
  } catch (error) {
    showNotice(error.message || '后端函数未连接', 'error');
  }
  await applyRoute();
})();
