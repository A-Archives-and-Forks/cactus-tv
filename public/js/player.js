let activeSession = null;
let hlsLoaderPromise = null;
let dashLoaderPromise = null;
let playbackGeneration = 0;
let subtitleUrls = [];
const preconnectedOrigins = new Set();

function emit(video, name, detail = {}) {
  video.dispatchEvent(new CustomEvent(`cactus:${name}`, { detail }));
}

function loadScript(src, ready, failureMessage) {
  if (ready()) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-cactus-src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => ready() ? resolve(ready()) : reject(new Error(failureMessage)), { once: true });
      existing.addEventListener('error', () => reject(new Error(failureMessage)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.cactusSrc = src;
    script.onload = () => ready() ? resolve(ready()) : reject(new Error(failureMessage));
    script.onerror = () => reject(new Error(failureMessage));
    document.head.appendChild(script);
  });
}

async function loadHls() {
  if (window.Hls) return window.Hls;
  if (!hlsLoaderPromise) {
    hlsLoaderPromise = loadScript('/vendor/hls.min.js?v=1.6.13', () => window.Hls, 'HLS 播放组件加载失败')
      .catch(error => { hlsLoaderPromise = null; throw error; });
  }
  return hlsLoaderPromise;
}

async function loadDash() {
  if (window.dashjs) return window.dashjs;
  if (!dashLoaderPromise) {
    dashLoaderPromise = loadScript('/vendor/dash.all.min.js?v=5.2.0', () => window.dashjs, 'DASH 播放组件加载失败')
      .catch(error => { dashLoaderPromise = null; throw error; });
  }
  return dashLoaderPromise;
}

function preloadPlayerEngine() {
  return loadHls().catch(() => null);
}

async function safePlay(video) {
  try {
    await video.play();
    return true;
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return false;
    throw error;
  }
}

function decodedTarget(url) {
  try {
    const parsed = new URL(url, location.href);
    return parsed.searchParams.get('url') || decodeURIComponent(url);
  } catch {
    try { return decodeURIComponent(url); }
    catch { return url; }
  }
}

function extensionKind(url) {
  const target = decodedTarget(url);
  if (/\.m3u8(?:$|[?#])/i.test(target)) return 'hls';
  if (/\.mpd(?:$|[?#])/i.test(target)) return 'dash';
  return '';
}

function isSameOriginProxy(url) {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === location.origin && parsed.pathname === '/api/stream';
  } catch { return false; }
}

function preconnect(url) {
  try {
    const origin = new URL(decodedTarget(url), location.href).origin;
    if (!/^https?:/i.test(origin) || preconnectedOrigins.has(origin)) return;
    preconnectedOrigins.add(origin);
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  } catch {}
}

async function probeStreamKind(url, timeoutMs = 6000) {
  const known = extensionKind(url);
  if (known) return known;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (isSameOriginProxy(url)) {
      const probe = new URL(url, location.href);
      probe.searchParams.set('probe', '1');
      const response = await fetch(probe, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return 'media';
      const payload = await response.json();
      return ['hls', 'dash', 'media'].includes(payload.kind) ? payload.kind : 'media';
    }

    // Some Apple CMS providers return an extensionless URL with a generic MIME type.
    // Probe only the first chunk; CORS failures safely fall back to native media playback.
    const response = await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/dash+xml, video/*, audio/*, */*;q=0.5',
        Range: 'bytes=0-65535',
      },
    });
    if (!response.ok && response.status !== 206) return 'media';
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('mpegurl')) { try { await response.body?.cancel(); } catch {} return 'hls'; }
    if (contentType.includes('dash+xml')) { try { await response.body?.cancel(); } catch {} return 'dash'; }
    const reader = response.body?.getReader();
    if (!reader) return 'media';
    const first = await reader.read();
    try { await reader.cancel(); } catch {}
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(first.value || new Uint8Array()).trimStart();
    if (sample.startsWith('#EXTM3U')) return 'hls';
    if (/^<\?xml[\s\S]{0,500}<MPD\b|^<MPD\b/i.test(sample)) return 'dash';
    return 'media';
  } catch { return 'media'; }
  finally { clearTimeout(timer); }
}

async function preloadStream(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  preconnect(value);
  if (navigator.connection?.saveData) return false;
  const kind = await probeStreamKind(value, 4500);
  if (kind === 'dash') loadDash().catch(() => null);
  if (kind !== 'hls' && kind !== 'dash') return false;
  try {
    const response = await fetch(value, {
      credentials: isSameOriginProxy(value) ? 'same-origin' : 'omit',
      cache: 'force-cache',
      priority: 'low',
      referrerPolicy: 'no-referrer',
      headers: { Accept: kind === 'hls' ? 'application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.8' : 'application/dash+xml, application/xml, */*;q=0.8' },
    });
    if (!response.ok) return false;
    await response.text();
    return true;
  } catch { return false; }
}

function supportsNativeHls(video) {
  const userAgent = navigator.userAgent || '';
  const appleMobile = /iP(?:hone|ad|od)/i.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/i.test(userAgent)
    && !/(?:Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android)/i.test(userAgent);
  const canPlay = video.canPlayType('application/vnd.apple.mpegurl')
    || video.canPlayType('application/x-mpegURL');
  return Boolean(canPlay && (appleMobile || safari));
}

function mediaError(video, fallback) {
  const code = video.error?.code;
  const messages = { 1: '播放已中止', 2: '媒体网络请求失败', 3: '媒体解码失败', 4: '浏览器不支持该媒体格式' };
  return new Error(messages[code] || video.error?.message || fallback);
}

function clearSubtitleTracks(video) {
  if (!video) return;
  [...video.querySelectorAll('track')].forEach(track => track.remove());
  try { [...video.textTracks].forEach(track => { track.mode = 'disabled'; }); } catch {}
  subtitleUrls.forEach(URL.revokeObjectURL);
  subtitleUrls = [];
}


async function requestSessionWakeLock(session) {
  if (!session || session.cleaned || session.wakeLock || !('wakeLock' in navigator) || document.hidden) return;
  try {
    session.wakeLock = await navigator.wakeLock.request('screen');
    session.wakeLock.addEventListener?.('release', () => {
      if (session) session.wakeLock = null;
    }, { once: true });
  } catch {}
}

function releaseSessionWakeLock(session) {
  const lock = session?.wakeLock;
  if (!lock) return;
  session.wakeLock = null;
  try { lock.release(); } catch {}
}

function cleanupSession(session, clearSource = true) {
  if (!session || session.cleaned) return;
  session.cleaned = true;
  session.timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); });
  session.timers.clear();
  session.listeners.forEach(([target, name, listener, options]) => target.removeEventListener(name, listener, options));
  session.listeners.length = 0;
  releaseSessionWakeLock(session);
  try { session.hls?.destroy(); } catch {}
  try { session.dash?.reset(); } catch {}
  session.hls = null;
  session.dash = null;
  if (clearSource) {
    session.video.pause();
    session.video.removeAttribute('src');
    session.video.load();
  }
}

function createSession(video, url, resumeAt) {
  const generation = ++playbackGeneration;
  const session = {
    generation, video, url,
    resumeAt: Math.max(0, Number(resumeAt) || 0),
    hls: null, dash: null, engine: 'native',
    listeners: [], timers: new Set(), cleaned: false, failed: false,
    started: false, verified: false, stable: false, autoplayBlocked: false,
    recoveredPosition: false, ready: false, networkRecoveries: 0, mediaRecoveries: 0,
    stallSince: 0, stallRecoveries: 0, stallCount: 0, lastProgressAt: performance.now(),
    lastCurrentTime: 0, startedAt: performance.now(), firstFrameAt: 0, bandwidth: 0,
    lastEmergencyDownshiftAt: 0, emergencyDownshifts: 0, bufferTarget: 0, cleanStreamRemoved: 0,
    wakeLock: null, offlineSince: 0, lastNetworkRecoveryAt: 0, bufferRampStage: 0,
  };
  activeSession = session;
  return session;
}

function listen(session, target, name, listener, options) {
  target.addEventListener(name, listener, options);
  session.listeners.push([target, name, listener, options]);
}

function addTimer(session, callback, delay, repeat = false) {
  const wrapped = () => {
    if (!repeat) session.timers.delete(timer);
    if (!session.cleaned && session.generation === playbackGeneration) callback();
  };
  const timer = repeat ? setInterval(wrapped, delay) : setTimeout(wrapped, delay);
  session.timers.add(timer);
  return timer;
}

function applyResume(session) {
  const { video, resumeAt } = session;
  if (session.recoveredPosition || resumeAt <= 3 || !Number.isFinite(video.duration)) return;
  if (resumeAt < video.duration - 5) {
    try { video.currentTime = resumeAt; } catch {}
  }
  session.recoveredPosition = true;
}

function bufferAhead(video) {
  const current = Number(video.currentTime || 0);
  let end = current;
  try {
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= current + 0.5) end = Math.max(end, video.buffered.end(index));
    }
  } catch {}
  return Math.max(0, end - current);
}

function diagnostics(session) {
  const { video } = session;
  let dropped = 0;
  let total = 0;
  try {
    const quality = video.getVideoPlaybackQuality?.();
    dropped = Number(quality?.droppedVideoFrames || video.webkitDroppedFrameCount || 0);
    total = Number(quality?.totalVideoFrames || video.webkitDecodedFrameCount || 0);
  } catch {}
  emit(video, 'diagnostics', {
    engine: session.engine,
    state: video.ended ? 'ended' : video.paused ? 'paused' : session.stallSince ? 'buffering' : 'playing',
    resolution: video.videoWidth && video.videoHeight ? `${video.videoWidth}×${video.videoHeight}` : '—',
    bandwidth: Math.round(Number(session.bandwidth || session.hls?.bandwidthEstimate || 0)),
    buffer: Number(bufferAhead(video).toFixed(1)),
    bufferTarget: Number(session.bufferTarget || 0),
    currentTime: Number((video.currentTime || 0).toFixed(1)),
    dropped, total,
    stalls: session.stallCount,
    startupMs: session.firstFrameAt ? Math.round(session.firstFrameAt - session.startedAt) : 0,
    urlHost: (() => { try { return new URL(decodedTarget(session.url), location.href).host; } catch { return ''; } })(),
  });
}

function failSession(session, error, recoverable = true) {
  if (session.cleaned || session.failed) return;
  session.failed = true;
  emit(session.video, 'error', { error: error instanceof Error ? error : new Error(String(error)), recoverable });
}

function emergencyDownshift(session) {
  const hls = session.hls;
  if (!hls || !Array.isArray(hls.levels) || hls.levels.length < 2) return false;
  const now = performance.now();
  if (now - session.lastEmergencyDownshiftAt < 3500) return false;
  const current = Number.isInteger(hls.currentLevel) && hls.currentLevel >= 0
    ? hls.currentLevel
    : Number.isInteger(hls.nextLoadLevel) && hls.nextLoadLevel >= 0
      ? hls.nextLoadLevel
      : hls.levels.length - 1;
  const next = Math.max(0, current - 1);
  if (next >= current) return false;
  session.lastEmergencyDownshiftAt = now;
  session.emergencyDownshifts += 1;
  try {
    hls.nextAutoLevel = next;
    emit(session.video, 'qualityRecovery', { from: current, to: next, reason: 'buffer-starvation' });
    return true;
  } catch { return false; }
}

function recoverStall(session) {
  const { video } = session;
  if (document.hidden || !navigator.onLine || session.cleaned || session.failed) return;
  session.stallRecoveries += 1;
  emit(video, 'state', { state: 'reconnecting', attempt: session.stallRecoveries });
  try {
    if (session.hls) {
      emergencyDownshift(session);
      const position = Math.max(0, Number(video.currentTime || 0) - 0.15);
      if (session.stallRecoveries === 1 && bufferAhead(video) > 0.45) {
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 0.08);
      } else {
        try { session.hls.stopLoad(); } catch {}
        if (session.stallRecoveries >= 3 && video.readyState < 2) {
          try { session.hls.recoverMediaError(); } catch {}
        }
        session.hls.startLoad(position);
      }
      safePlay(video).catch(() => {});
    } else if (session.dash) {
      const position = video.currentTime || 0;
      try { session.dash.setQualityFor?.('video', Math.max(0, Number(session.dash.getQualityFor?.('video') || 0) - 1)); } catch {}
      session.dash.seek(position);
      session.dash.play();
    } else {
      const position = video.currentTime || 0;
      video.load();
      listen(session, video, 'loadedmetadata', () => { try { video.currentTime = position; safePlay(video); } catch {} }, { once: true });
    }
  } catch {}
}

function bindStallMonitor(session) {
  const { video } = session;
  const markProgress = () => {
    const now = performance.now();
    const current = Number(video.currentTime || 0);
    if (current > session.lastCurrentTime + 0.08) {
      session.lastProgressAt = now;
      session.lastCurrentTime = current;
      session.stallSince = 0;
      session.stallRecoveries = 0;
    }
  };
  const markStall = () => {
    if (!session.verified || video.paused || video.seeking || document.hidden || !navigator.onLine) return;
    if (!session.stallSince) {
      session.stallSince = performance.now();
      session.stallCount += 1;
    }
  };
  listen(session, video, 'timeupdate', markProgress);
  listen(session, video, 'progress', markProgress);
  listen(session, video, 'playing', markProgress);
  listen(session, video, 'seeked', () => {
    session.lastCurrentTime = Number(video.currentTime || 0);
    session.lastProgressAt = performance.now();
    session.stallSince = 0;
    session.stallRecoveries = 0;
  });
  listen(session, video, 'waiting', markStall);
  listen(session, video, 'stalled', markStall);
  addTimer(session, () => {
    diagnostics(session);
    if (!session.verified || video.paused || video.ended || video.seeking || session.failed || document.hidden || !navigator.onLine) return;
    const now = performance.now();
    const noProgress = now - session.lastProgressAt;
    const starving = bufferAhead(video) < 0.25;
    if (noProgress < 6500 || (!starving && !session.stallSince)) return;
    if (!session.stallSince) {
      session.stallSince = now;
      session.stallCount += 1;
      emit(video, 'state', { state: 'buffering' });
      return;
    }
    const stalledFor = now - session.stallSince;
    if (stalledFor > 5000 && session.stallRecoveries < 3) recoverStall(session);
    if (stalledFor > 20000) failSession(session, new Error('播放持续卡住，正在切换备用线路'));
  }, 3000, true);
}

function verifySession(session) {
  if (session.verified || session.cleaned) return;
  session.verified = true;
  session.firstFrameAt = performance.now();
  emit(session.video, 'verified', { startupMs: Math.round(session.firstFrameAt - session.startedAt), engine: session.engine });
  const verifiedAt = Number(session.video.currentTime || 0);
  const markStable = () => {
    if (session.stable || session.cleaned || session.failed || !session.verified) return;
    if (Number(session.video.currentTime || 0) < verifiedAt + 0.8) return;
    session.stable = true;
    emit(session.video, 'stable', { engine: session.engine });
  };
  listen(session, session.video, 'timeupdate', markStable);
  listen(session, session.video, 'playing', markStable);
  addTimer(session, markStable, 3500);
}

function waitForFirstFrame(session, timeoutMs) {
  const { video } = session;
  return new Promise((resolve, reject) => {
    let settled = false;
    let frameRequested = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else { verifySession(session); resolve(); }
    };
    const confirm = () => {
      if (session.cleaned) return finish(new DOMException('播放已取消', 'AbortError'));
      if (video.readyState < 2) return;
      if (!session.started && !session.autoplayBlocked && video.paused) return;
      if ('requestVideoFrameCallback' in video && !frameRequested && !session.autoplayBlocked) {
        frameRequested = true;
        video.requestVideoFrameCallback(() => finish());
        return;
      }
      finish();
    };
    listen(session, video, 'playing', () => { session.started = true; confirm(); });
    listen(session, video, 'loadeddata', confirm);
    listen(session, video, 'canplay', confirm);
    listen(session, video, 'timeupdate', confirm);
    listen(session, video, 'error', () => finish(mediaError(video, '媒体加载失败')), { once: true });
    const timeout = addTimer(session, () => finish(new Error('首帧加载超时')), timeoutMs);
    confirm();
  });
}

function bindMediaState(session) {
  const { video } = session;
  const state = value => emit(video, 'state', { state: value });

  const resumeAfterNetwork = () => {
    if (session.cleaned || session.failed || !navigator.onLine) return;
    session.offlineSince = 0;
    session.lastProgressAt = performance.now();
    session.stallSince = 0;
    emit(video, 'state', { state: 'reconnecting', reason: 'online' });
    try {
      if (session.hls) {
        session.hls.startLoad(Math.max(0, Number(video.currentTime || 0) - 0.15));
      } else if (session.dash) {
        session.dash.seek(Number(video.currentTime || 0));
      } else {
        video.load();
      }
      safePlay(video).catch(() => {});
    } catch {}
  };

  listen(session, video, 'loadstart', () => state('loading'));
  listen(session, video, 'waiting', () => { if (!video.paused && !video.seeking && navigator.onLine && !document.hidden) state('buffering'); });
  listen(session, video, 'stalled', () => { if (!video.paused && navigator.onLine && !document.hidden) state('buffering'); });
  listen(session, video, 'seeking', () => state('buffering'));
  listen(session, video, 'playing', () => {
    session.started = true;
    requestSessionWakeLock(session);
    state('playing');
  });
  listen(session, video, 'canplay', () => state(video.paused ? 'ready' : 'playing'));
  listen(session, video, 'pause', () => {
    releaseSessionWakeLock(session);
    if (!video.ended && !video.error) state('paused');
  });
  listen(session, video, 'ended', () => {
    releaseSessionWakeLock(session);
    state('ended');
  });
  listen(session, video, 'loadedmetadata', () => { session.ready = true; applyResume(session); });
  listen(session, video, 'error', () => {
    if (!session.verified || session.hls || session.dash) return;
    failSession(session, mediaError(video, '媒体播放失败'));
  });

  listen(session, window, 'offline', () => {
    session.offlineSince = performance.now();
    session.stallSince = 0;
    emit(video, 'state', { state: 'reconnecting', reason: 'offline' });
  });
  listen(session, window, 'online', resumeAfterNetwork);
  listen(session, document, 'visibilitychange', () => {
    if (document.hidden) {
      session.stallSince = 0;
      session.lastProgressAt = performance.now();
      releaseSessionWakeLock(session);
      return;
    }
    if (!video.paused && !video.ended) {
      requestSessionWakeLock(session);
      if (session.offlineSince && navigator.onLine) resumeAfterNetwork();
      else safePlay(video).catch(() => {});
    }
  });

  bindStallMonitor(session);
}

async function playNative(session) {
  const { video, url } = session;
  session.engine = 'native';
  emit(video, 'engine', { engine: 'native' });
  emit(video, 'levels', { levels: [], currentLevel: -1, auto: true });
  emit(video, 'audioTracks', { tracks: [], current: -1 });
  emit(video, 'subtitleTracks', { tracks: [], current: -1 });
  video.src = url;
  video.load();
  session.autoplayBlocked = !(await safePlay(video));
  await waitForFirstFrame(session, 11000);
}

function deviceProfile() {
  const connection = navigator.connection || {};
  const downlink = Number(connection.downlink || 0);
  const memory = Number(navigator.deviceMemory || 8);
  const cores = Number(navigator.hardwareConcurrency || 8);
  const slowNetwork = /(^|-)2g$|3g/i.test(connection.effectiveType || '')
    || (downlink > 0 && downlink < 2)
    || (Number(connection.rtt || 0) > 450);
  const lowMemory = memory <= 2;
  const lowCpu = cores <= 2;
  const constrained = Boolean(connection.saveData || /(^|-)2g$/i.test(connection.effectiveType || '') || (lowMemory && lowCpu));
  const mobile = matchMedia('(max-width: 900px)').matches || matchMedia('(pointer: coarse)').matches;

  // Keep the deep buffer active from the first HLS load. Limiting the initial
  // target to 45/60 seconds made hls.js stop requesting as soon as that small
  // window filled, which sharply reduced sustained download throughput.
  const targetBuffer = constrained ? 90 : mobile ? 200 : 300;
  const memorySafeBuffer = constrained ? 60 : mobile ? 100 : 150;
  const maxBuffer = constrained ? 140 : mobile ? 300 : 450;
  const backBuffer = constrained ? 36 : mobile ? 100 : 160;
  // Private-cinema profile: allow the player to keep a much larger byte
  // reservoir while the time window remains bounded by targetBuffer/maxBuffer.
  // maxBufferSize is a ceiling, not an eager allocation; memory-pressure events
  // below shrink it automatically instead of letting the tab become unstable.
  const maxBufferBytes = constrained
    ? 192 * 1024 * 1024
    : mobile
      ? (memory >= 8 ? 768 : memory >= 4 ? 512 : 384) * 1024 * 1024
      : (memory >= 8 ? 1536 : 896) * 1024 * 1024;
  const bufferByteFloor = constrained
    ? 96 * 1024 * 1024
    : mobile
      ? (memory >= 8 ? 384 : 256) * 1024 * 1024
      : (memory >= 8 ? 768 : 512) * 1024 * 1024;
  return {
    constrained, mobile, slowNetwork, downlink, lowMemory, lowCpu, memory, cores,
    targetBuffer, memorySafeBuffer, maxBuffer, backBuffer, maxBufferBytes, bufferByteFloor,
  };
}

function levelPayload(hls) {
  const levels = (hls.levels || []).map((level, index) => {
    const height = Number(level.height || 0);
    const bitrate = Number(level.bitrate || 0);
    return { index, height, bitrate, label: height ? `${height}p` : bitrate ? `${Math.round(bitrate / 1000)} kbps` : `清晰度 ${index + 1}` };
  });
  return { levels, currentLevel: Number(hls.currentLevel ?? -1), auto: hls.autoLevelEnabled !== false && hls.currentLevel === -1 };
}

function emitHlsTracks(session, Hls) {
  const hls = session.hls;
  const audio = (hls.audioTracks || []).map((track, index) => ({ index, label: track.name || track.lang || `音轨 ${index + 1}`, lang: track.lang || '' }));
  const subtitles = (hls.subtitleTracks || []).map((track, index) => ({ index, label: track.name || track.lang || `字幕 ${index + 1}`, lang: track.lang || '' }));
  emit(session.video, 'audioTracks', { tracks: audio, current: Number(hls.audioTrack ?? -1) });
  emit(session.video, 'subtitleTracks', { tracks: subtitles, current: Number(hls.subtitleTrack ?? -1) });
}

async function playWithHls(session) {
  const Hls = await loadHls();
  if (session.cleaned || session.generation !== playbackGeneration) throw new DOMException('播放已取消', 'AbortError');
  if (!Hls.isSupported()) throw new Error('当前浏览器不支持 HLS 播放');
  const profile = deviceProfile();
  const { constrained, mobile, slowNetwork, downlink } = profile;
  const proxied = isSameOriginProxy(session.url);
  const defaultEstimate = downlink
    ? Math.max(900000, Math.min(12_000_000, downlink * 850000))
    : mobile ? 2_800_000 : 4_500_000;
  session.bufferTarget = profile.targetBuffer;
  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    capLevelToPlayerSize: true,
    capLevelOnFPSDrop: true,
    fpsDroppedMonitoringPeriod: 5000,
    fpsDroppedMonitoringThreshold: 0.18,
    startLevel: slowNetwork ? 0 : -1,
    startFragPrefetch: true,
    testBandwidth: true,
    abrEwmaDefaultEstimate: defaultEstimate,
    abrEwmaFastVoD: 2,
    abrEwmaSlowVoD: 7,
    abrMaxWithRealBitrate: true,
    abrBandWidthFactor: slowNetwork ? 0.72 : 0.88,
    abrBandWidthUpFactor: slowNetwork ? 0.55 : 0.76,
    maxStarvationDelay: slowNetwork ? 2 : 3.5,
    maxLoadingDelay: slowNetwork ? 2.5 : 5,
    // Keep the full local buffer target active immediately.
    backBufferLength: profile.backBuffer,
    maxBufferLength: profile.targetBuffer,
    maxMaxBufferLength: profile.maxBuffer,
    maxBufferSize: profile.maxBufferBytes,
    maxBufferHole: 0.3,
    maxFragLookUpTolerance: 0.2,
    progressive: true,
    enableSoftwareAES: true,
    highBufferWatchdogPeriod: 3,
    nudgeOffset: 0.08,
    nudgeMaxRetry: 4,
    manifestLoadingTimeOut: 10000,
    manifestLoadingMaxRetry: 2,
    manifestLoadingRetryDelay: 500,
    levelLoadingTimeOut: 12000,
    levelLoadingMaxRetry: 3,
    levelLoadingRetryDelay: 500,
    fragLoadingTimeOut: proxied ? 12000 : 20000,
    fragLoadingMaxRetry: proxied ? 1 : 3,
    fragLoadingRetryDelay: 600,
    fragLoadingMaxRetryTimeout: 5000,
    appendErrorMaxRetry: 3,
  });
  session.hls = hls;
  session.engine = 'hls.js';
  emit(session.video, 'engine', { engine: 'hls.js' });

  await new Promise((resolve, reject) => {
    let settled = false;
    let manifestReady = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      error ? reject(error) : resolve();
    };
    const fatal = data => {
      const error = new Error(`播放失败：${data.details || data.type || '未知错误'}`);
      if (!session.verified) finish(error); else failSession(session, error, false);
    };
    const startupTimer = addTimer(session, () => finish(new Error(manifestReady ? '首个视频分片加载超时' : '播放列表加载超时')), proxied ? 13000 : 20000);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (!session.cleaned) hls.loadSource(session.url); });
    hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
      try {
        const details = data?.networkDetails;
        const getHeader = name => {
          if (details?.headers?.get) return details.headers.get(name);
          if (typeof details?.getResponseHeader === 'function') return details.getResponseHeader(name);
          return null;
        };
        const mode = String(getHeader('x-cactus-cleanstream') || '').toUpperCase();
        const removed = Number(getHeader('x-cactus-cleanstream-removed') || 0);
        session.cleanStreamRemoved = Number.isFinite(removed) ? removed : 0;
        if (mode) emit(session.video, 'cleanstream', { mode, removed: session.cleanStreamRemoved });
      } catch {}
    });
    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      manifestReady = true;
      emit(session.video, 'levels', levelPayload(hls));
      emitHlsTracks(session, Hls);
      applyResume(session);
      try {
        session.autoplayBlocked = !(await safePlay(session.video));
        await waitForFirstFrame(session, proxied ? 12000 : 17000);
        finish();
      } catch (error) { finish(error); }
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => emit(session.video, 'quality', { currentLevel: Number(data.level ?? -1), auto: hls.autoLevelEnabled }));
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      const loaded = Number(data?.stats?.loaded || 0);
      const durationMs = Math.max(1, Number(data?.stats?.loading?.end || 0) - Number(data?.stats?.loading?.start || 0));
      if (loaded) session.bandwidth = Math.round((loaded * 8 * 1000) / durationMs);
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      session.networkRecoveries = 0; session.mediaRecoveries = 0;
      emit(session.video, 'state', { state: session.video.paused ? 'ready' : 'playing' });
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (session.cleaned) return;

      const detail = String(data?.details || '');
      if (!data.fatal) {
        if (/bufferStalledError|bufferNudgeOnStall/i.test(detail) && !session.video.paused && !session.video.seeking) {
          if (!session.stallSince) {
            session.stallSince = performance.now();
            session.stallCount += 1;
          }
          emit(session.video, 'state', { state: 'buffering' });
        }
        if (/bufferFullError/i.test(detail)) {
          const safeTarget = Math.min(session.bufferTarget || profile.targetBuffer, profile.memorySafeBuffer);
          const currentByteCeiling = Number(hls.config.maxBufferSize || profile.maxBufferBytes);
          const safeByteCeiling = Math.max(profile.bufferByteFloor, Math.floor(currentByteCeiling * 0.72));
          hls.config.maxBufferLength = safeTarget;
          hls.config.maxBufferSize = safeByteCeiling;
          session.bufferTarget = safeTarget;
          emit(session.video, 'bufferTarget', {
            engine: 'hls.js',
            target: safeTarget,
            maxBufferBytes: safeByteCeiling,
            reason: 'memory-pressure',
          });
        }
        return;
      }

      if (!session.verified && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        fatal(data);
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && session.networkRecoveries < 2) {
        const attempt = ++session.networkRecoveries;
        emergencyDownshift(session);
        emit(session.video, 'state', { state: 'reconnecting', attempt });
        addTimer(session, () => {
          if (!navigator.onLine || document.hidden) return;
          try {
            hls.stopLoad();
            hls.startLoad(Math.max(0, session.video.currentTime || -1));
            safePlay(session.video).catch(() => {});
          } catch { fatal(data); }
        }, Math.min(650 * (2 ** (attempt - 1)), 2200));
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && session.mediaRecoveries < 2) {
        const attempt = ++session.mediaRecoveries;
        emit(session.video, 'state', { state: 'recovering', attempt });
        try {
          if (attempt === 2) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        } catch { fatal(data); return; }
      }
      fatal(data);
    });
    hls.attachMedia(session.video);
  });
}

function dashRequestMapper(sourceUrl) {
  try {
    const source = new URL(sourceUrl, location.href);
    if (source.origin !== location.origin || source.pathname !== '/api/stream') return null;
    const provider = source.searchParams.get('provider');
    const original = source.searchParams.get('url');
    if (!provider || !original) return null;
    const originalBase = new URL('.', original);
    return requestUrl => {
      try {
        const request = new URL(requestUrl, originalBase);
        if (request.origin === location.origin && request.pathname === '/api/stream') return request.toString();
        if (!/^https?:$/.test(request.protocol)) return requestUrl;
        return `/api/stream?provider=${encodeURIComponent(provider)}&url=${encodeURIComponent(request.toString())}`;
      } catch { return requestUrl; }
    };
  } catch { return null; }
}

async function playWithDash(session) {
  const dashjs = await loadDash();
  if (session.cleaned || session.generation !== playbackGeneration) throw new DOMException('播放已取消', 'AbortError');
  const player = dashjs.MediaPlayer().create();
  const mapDashRequest = dashRequestMapper(session.url);
  if (mapDashRequest && typeof player.addRequestInterceptor === 'function') {
    player.addRequestInterceptor(async request => ({ ...request, url: mapDashRequest(request.url) }));
  } else if (mapDashRequest && typeof player.extend === 'function') {
    // Compatibility with older dash.js versions.
    player.extend('RequestModifier', () => ({
      modifyRequestURL: mapDashRequest,
      modifyRequestHeader: xhr => xhr,
    }), true);
  }
  session.dash = player;
  session.engine = 'dash.js';
  emit(session.video, 'engine', { engine: 'dash.js' });
  const profile = deviceProfile();
  session.bufferTarget = profile.targetBuffer;
  player.updateSettings({ streaming: {
    abr: {
      autoSwitchBitrate: { video: true, audio: true },
      initialBitrate: { video: profile.slowNetwork ? 350 : -1 },
      limitBitrateByPortal: true,
      useDeadTimeLatency: true,
    },
    buffer: {
      bufferTimeDefault: profile.targetBuffer,
      bufferTimeAtTopQuality: profile.targetBuffer,
      bufferTimeAtTopQualityLongForm: profile.maxBuffer,
      bufferToKeep: profile.backBuffer,
      fastSwitchEnabled: true,
    },
    retryAttempts: { MPD: 2, MediaSegment: 4, InitializationSegment: 3 },
    retryIntervals: { MPD: 500, MediaSegment: 500, InitializationSegment: 500 },
  }});
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const events = dashjs.MediaPlayer.events;
    player.on(events.STREAM_INITIALIZED, async () => {
      try {
        const levels = (player.getBitrateInfoListFor('video') || []).map((level, index) => ({ index, height: level.height || 0, bitrate: level.bitrate || 0, label: level.height ? `${level.height}p` : `${Math.round((level.bitrate || 0) / 1000)} kbps` }));
        emit(session.video, 'levels', { levels, currentLevel: -1, auto: true });
        const audio = (player.getTracksFor('audio') || []).map((track, index) => ({ index, label: track.labels?.[0]?.text || track.lang || `音轨 ${index + 1}`, lang: track.lang || '' }));
        const subtitles = (player.getTracksFor('text') || []).map((track, index) => ({ index, label: track.labels?.[0]?.text || track.lang || `字幕 ${index + 1}`, lang: track.lang || '' }));
        emit(session.video, 'audioTracks', { tracks: audio, current: -1 });
        emit(session.video, 'subtitleTracks', { tracks: subtitles, current: -1 });
        applyResume(session);
        session.autoplayBlocked = !(await safePlay(session.video));
        await waitForFirstFrame(session, 14000);
        finish();
      } catch (error) { finish(error); }
    });
    player.on(events.QUALITY_CHANGE_RENDERED, data => {
      if (data?.mediaType === 'video') emit(session.video, 'quality', { currentLevel: Number(data.newQuality ?? -1), auto: true });
    });
    player.on(events.ERROR, data => {
      const error = new Error(data?.error?.message || data?.event?.message || 'DASH 播放失败');
      if (!session.verified) finish(error); else failSession(session, error);
    });
    const timeout = addTimer(session, () => finish(new Error('DASH 首帧加载超时')), 17000);
    player.initialize(session.video, session.url, false);
  });
}

async function playStream(video, url, preferNativeHls = true, resumeAt = 0) {
  stopStream(video);
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/api/stream?')) throw new Error('播放地址格式无效');
  preconnect(value);
  const session = createSession(video, value, resumeAt);
  video.preload = 'auto';
  bindMediaState(session);
  emit(video, 'state', { state: 'loading' });
  try {
    const kind = await probeStreamKind(value);
    if (session.cleaned) return;
    if (kind === 'dash') await playWithDash(session);
    else if (kind === 'hls') {
      if (preferNativeHls && supportsNativeHls(video)) {
        try { await playNative(session); }
        catch (error) {
          if (session.cleaned) return;
          session.listeners.splice(0).forEach(([target, name, listener, options]) => target.removeEventListener(name, listener, options));
          session.timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); });
          session.timers.clear();
          video.pause(); video.removeAttribute('src'); video.load();
          session.failed = false; session.verified = false; session.started = false; session.ready = false;
          bindMediaState(session);
          emit(video, 'state', { state: 'loading', fallback: 'hls.js' });
          await playWithHls(session);
        }
      } else await playWithHls(session);
    } else await playNative(session);
    diagnostics(session);
  } catch (error) {
    if (!session.cleaned && session.generation === playbackGeneration) failSession(session, error);
    throw error;
  }
}

function setPlaybackQuality(level) {
  const session = activeSession;
  if (!session) return false;
  const value = Number(level);
  if (session.hls) {
    if (!Number.isInteger(value) || value < 0) { session.hls.currentLevel = -1; session.hls.nextLevel = -1; }
    else if (value < session.hls.levels.length) session.hls.nextLevel = value;
    else return false;
    emit(session.video, 'quality', { currentLevel: value < 0 ? -1 : value, auto: value < 0 });
    return true;
  }
  if (session.dash) {
    try {
      if (value < 0) session.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
      else { session.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } }); session.dash.setRepresentationForTypeByIndex('video', value, true); }
      emit(session.video, 'quality', { currentLevel: value, auto: value < 0 });
      return true;
    } catch { return false; }
  }
  return false;
}

function setPlaybackAudioTrack(index) {
  const session = activeSession;
  const value = Number(index);
  if (session?.hls && value >= 0 && value < session.hls.audioTracks.length) { session.hls.audioTrack = value; return true; }
  if (session?.dash) {
    try { const track = session.dash.getTracksFor('audio')?.[value]; if (track) { session.dash.setCurrentTrack(track); return true; } } catch {}
  }
  return false;
}

function setPlaybackSubtitleTrack(index) {
  const session = activeSession;
  const value = Number(index);
  if (session?.hls) { session.hls.subtitleTrack = Number.isInteger(value) ? value : -1; session.hls.subtitleDisplay = value >= 0; return true; }
  if (session?.dash) {
    try {
      if (value < 0) session.dash.enableText(false);
      else { const track = session.dash.getTracksFor('text')?.[value]; if (track) { session.dash.enableText(true); session.dash.setCurrentTrack(track); } }
      return true;
    } catch {}
  }
  return false;
}

function srtToVtt(text) {
  return `WEBVTT\n\n${text.replace(/^\uFEFF/, '').replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

function decodeSubtitle(buffer) {
  const bytes = new Uint8Array(buffer);
  const attempts = [];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) attempts.push('utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) attempts.push('utf-16be');
  attempts.push('utf-8', 'gb18030', 'big5');
  let best = '';
  let bestBad = Infinity;
  for (const encoding of attempts) {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      const bad = (text.match(/�/g) || []).length;
      if (bad < bestBad) { best = text; bestBad = bad; }
      if (!bad) break;
    } catch {}
  }
  return best;
}

async function remoteSubtitle(subtitle) {
  const format = String(subtitle.format || '').toLowerCase();
  if (!['vtt', 'srt', ''].includes(format)) throw new Error('当前仅支持 VTT 和 SRT 字幕');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const endpoint = new URL('/api/subtitle', location.origin);
    endpoint.searchParams.set('url', subtitle.url);
    const response = await fetch(endpoint, { credentials: 'same-origin', signal: controller.signal, cache: 'force-cache' });
    if (!response.ok) throw new Error(`字幕加载失败（${response.status}）`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 5_000_000) throw new Error('远程字幕不能超过 5 MB');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 5_000_000) throw new Error('远程字幕不能超过 5 MB');
    let text = decodeSubtitle(buffer);
    if (format === 'srt' || /\.srt(?:$|\?)/i.test(subtitle.url) || !/^\s*WEBVTT/i.test(text)) text = srtToVtt(text);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
    subtitleUrls.push(url);
    return url;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('字幕加载超时');
    throw error;
  } finally { clearTimeout(timer); }
}

async function loadSubtitle(video, subtitle) {
  clearSubtitleTracks(video);
  if (!subtitle) return;
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = subtitle.name || subtitle.lang || '字幕';
  track.srclang = subtitle.lang || 'zh';
  track.src = subtitle.localUrl || await remoteSubtitle(subtitle);
  track.default = true;
  video.appendChild(track);
  track.addEventListener('load', () => {
    [...video.textTracks].forEach(item => { item.mode = item === track.track ? 'showing' : 'disabled'; });
  }, { once: true });
}

async function localSubtitle(file) {
  if (!/\.(vtt|srt)$/i.test(file.name)) throw new Error('请选择 VTT 或 SRT 字幕文件');
  if (file.size > 5_000_000) throw new Error('字幕文件不能超过 5 MB');
  let text = decodeSubtitle(await file.arrayBuffer());
  if (/\.srt$/i.test(file.name)) text = srtToVtt(text);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
  subtitleUrls.push(url);
  return { name: file.name, lang: 'local', format: 'vtt', localUrl: url };
}

function stopStream(video) {
  playbackGeneration += 1;
  if (activeSession) cleanupSession(activeSession, true);
  activeSession = null;
  if (video && !video.paused) video.pause();
  clearSubtitleTracks(video);
}

export {
  clearSubtitleTracks,
  loadSubtitle,
  localSubtitle,
  playStream,
  preloadPlayerEngine,
  preloadStream,
  setPlaybackAudioTrack,
  setPlaybackQuality,
  setPlaybackSubtitleTrack,
  stopStream,
};
