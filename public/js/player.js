let activeSession = null;
let hlsLoaderPromise = null;
let playbackGeneration = 0;
let subtitleUrls = [];

function emit(video, name, detail = {}) {
  video.dispatchEvent(new CustomEvent(`cactus:${name}`, { detail }));
}

async function loadHls() {
  if (window.Hls) return window.Hls;
  if (!hlsLoaderPromise) {
    hlsLoaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/hls.min.js?v=1.6.13';
      script.async = true;
      script.onload = () => window.Hls
        ? resolve(window.Hls)
        : reject(new Error('HLS 播放组件未正确初始化'));
      script.onerror = () => reject(new Error('HLS 播放组件加载失败'));
      document.head.appendChild(script);
    }).catch(error => {
      hlsLoaderPromise = null;
      throw error;
    });
  }
  return hlsLoaderPromise;
}

async function safePlay(video) {
  try {
    await video.play();
  } catch (error) {
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') throw error;
  }
}

function decodedTarget(url) {
  try {
    return new URL(url, location.href).searchParams.get('url') || decodeURIComponent(url);
  } catch {
    try { return decodeURIComponent(url); }
    catch { return url; }
  }
}

function isHlsUrl(url) {
  return /\.m3u8(?:$|[?#])/i.test(decodedTarget(url));
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
  const messages = {
    1: '播放已中止',
    2: '媒体网络请求失败',
    3: '媒体解码失败',
    4: '浏览器不支持该媒体格式',
  };
  return new Error(messages[code] || video.error?.message || fallback);
}

function cleanupSession(session, clearSource = true) {
  if (!session || session.cleaned) return;
  session.cleaned = true;
  session.timers.forEach(timer => clearTimeout(timer));
  session.timers.clear();
  session.listeners.forEach(([target, name, listener, options]) => {
    target.removeEventListener(name, listener, options);
  });
  session.listeners.length = 0;
  session.hls?.destroy();
  session.hls = null;

  if (clearSource) {
    session.video.pause();
    session.video.removeAttribute('src');
    session.video.load();
  }
}

function createSession(video, url, resumeAt) {
  const generation = ++playbackGeneration;
  const session = {
    generation,
    video,
    url,
    resumeAt: Math.max(0, Number(resumeAt) || 0),
    hls: null,
    listeners: [],
    timers: new Set(),
    cleaned: false,
    started: false,
    recoveredPosition: false,
    ready: false,
    networkRecoveries: 0,
    mediaRecoveries: 0,
  };
  activeSession = session;
  return session;
}

function listen(session, target, name, listener, options) {
  target.addEventListener(name, listener, options);
  session.listeners.push([target, name, listener, options]);
}

function addTimer(session, callback, delay) {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    if (!session.cleaned && session.generation === playbackGeneration) callback();
  }, delay);
  session.timers.add(timer);
  return timer;
}

function applyResume(session) {
  const { video, resumeAt } = session;
  if (session.recoveredPosition || resumeAt <= 3 || !Number.isFinite(video.duration)) return;
  if (resumeAt < video.duration - 5) {
    try { video.currentTime = resumeAt; }
    catch {}
  }
  session.recoveredPosition = true;
}

function bindMediaState(session) {
  const { video } = session;
  const state = value => emit(video, 'state', { state: value });
  listen(session, video, 'loadstart', () => state('loading'));
  listen(session, video, 'waiting', () => state('buffering'));
  listen(session, video, 'stalled', () => state('buffering'));
  listen(session, video, 'seeking', () => state('buffering'));
  listen(session, video, 'playing', () => {
    session.started = true;
    state('playing');
  });
  listen(session, video, 'canplay', () => state(video.paused ? 'ready' : 'playing'));
  listen(session, video, 'pause', () => {
    if (!video.ended && !video.error) state('paused');
  });
  listen(session, video, 'ended', () => state('ended'));
  listen(session, video, 'loadedmetadata', () => {
    session.ready = true;
    applyResume(session);
  });
  listen(session, video, 'error', () => {
    if (!session.ready || session.hls) return;
    emit(video, 'error', { error: mediaError(video, '媒体播放失败'), recoverable: true });
  });
}

async function playNative(session) {
  const { video, url } = session;
  emit(video, 'engine', { engine: 'native' });
  emit(video, 'levels', { levels: [], currentLevel: -1, auto: true });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const onLoaded = () => {
      applyResume(session);
      finish();
    };
    const onError = () => finish(mediaError(video, '媒体加载失败'));
    listen(session, video, 'loadedmetadata', onLoaded, { once: true });
    listen(session, video, 'error', onError, { once: true });
    const timeout = addTimer(session, () => finish(new Error('媒体加载超时')), 15_000);
    video.src = url;
    video.load();
  });

  if (session.cleaned) return;
  await safePlay(video);
}

function deviceProfile() {
  const constrained = Boolean(
    navigator.connection?.saveData
    || (navigator.deviceMemory && navigator.deviceMemory <= 4)
    || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
  );
  const mobile = matchMedia('(max-width: 800px)').matches;
  return { constrained, mobile };
}

function levelPayload(hls) {
  const levels = (hls.levels || []).map((level, index) => {
    const height = Number(level.height || 0);
    const bitrate = Number(level.bitrate || 0);
    const label = height
      ? `${height}p`
      : bitrate
        ? `${Math.round(bitrate / 1000)} kbps`
        : `清晰度 ${index + 1}`;
    return { index, height, bitrate, label };
  });
  return {
    levels,
    currentLevel: Number(hls.currentLevel ?? -1),
    auto: hls.autoLevelEnabled !== false && hls.currentLevel === -1,
  };
}

async function playWithHls(session) {
  const Hls = await loadHls();
  if (session.cleaned || session.generation !== playbackGeneration) return;
  if (!Hls.isSupported()) throw new Error('当前浏览器不支持 HLS 播放');

  const { constrained, mobile } = deviceProfile();
  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    capLevelToPlayerSize: true,
    startLevel: -1,
    startFragPrefetch: false,
    backBufferLength: constrained ? 12 : 30,
    maxBufferLength: constrained ? 18 : mobile ? 28 : 40,
    maxMaxBufferLength: constrained ? 30 : mobile ? 50 : 75,
    maxBufferSize: constrained ? 24 * 1024 * 1024 : 52 * 1024 * 1024,
    maxBufferHole: 0.5,
    highBufferWatchdogPeriod: 2,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    manifestLoadingTimeOut: 12_000,
    manifestLoadingMaxRetry: 3,
    levelLoadingTimeOut: 12_000,
    levelLoadingMaxRetry: 4,
    fragLoadingTimeOut: 20_000,
    fragLoadingMaxRetry: 4,
    appendErrorMaxRetry: 3,
  });
  session.hls = hls;
  emit(session.video, 'engine', { engine: 'hls.js' });

  await new Promise((resolve, reject) => {
    let settled = false;
    let startupTimer;

    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      error ? reject(error) : resolve();
    };

    const fatal = data => {
      const error = new Error(`播放失败：${data.details || data.type || '未知错误'}`);
      if (!settled) finish(error);
      else emit(session.video, 'error', { error, recoverable: false });
    };

    startupTimer = addTimer(session, () => finish(new Error('播放列表加载超时')), 25_000);

    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      if (!session.cleaned) hls.loadSource(session.url);
    });

    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      if (session.cleaned) return;
      emit(session.video, 'levels', levelPayload(hls));
      applyResume(session);
      try {
        await safePlay(session.video);
        finish();
      } catch (error) {
        finish(error);
      }
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      emit(session.video, 'quality', {
        currentLevel: Number(data.level ?? -1),
        auto: hls.autoLevelEnabled,
      });
    });

    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      session.networkRecoveries = 0;
      session.mediaRecoveries = 0;
      emit(session.video, 'state', { state: session.video.paused ? 'ready' : 'playing' });
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || session.cleaned) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && session.networkRecoveries < 4) {
        const attempt = ++session.networkRecoveries;
        emit(session.video, 'state', { state: 'reconnecting', attempt });
        addTimer(session, () => {
          try { hls.startLoad(Math.max(0, session.video.currentTime || -1)); }
          catch { fatal(data); }
        }, Math.min(600 * (2 ** (attempt - 1)), 4_000));
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && session.mediaRecoveries < 3) {
        const attempt = ++session.mediaRecoveries;
        emit(session.video, 'state', { state: 'recovering', attempt });
        try {
          if (attempt === 2) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        } catch {
          fatal(data);
          return;
        }
      }

      fatal(data);
    });

    hls.attachMedia(session.video);
  });
}

async function playStream(video, url, preferNativeHls = true, resumeAt = 0) {
  stopStream(video);
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/api/stream?')) {
    throw new Error('播放地址格式无效');
  }

  const session = createSession(video, value, resumeAt);
  video.preload = 'auto';
  bindMediaState(session);
  emit(video, 'state', { state: 'loading' });

  try {
    if (!isHlsUrl(value)) {
      await playNative(session);
      return;
    }

    if (preferNativeHls && supportsNativeHls(video)) {
      try {
        await playNative(session);
        return;
      } catch (error) {
        if (session.cleaned) return;
        session.listeners.splice(0).forEach(([target, name, listener, options]) => {
          target.removeEventListener(name, listener, options);
        });
        session.timers.forEach(timer => clearTimeout(timer));
        session.timers.clear();
        video.pause();
        video.removeAttribute('src');
        video.load();
        bindMediaState(session);
        emit(video, 'state', { state: 'loading', fallback: 'hls.js' });
      }
    }

    await playWithHls(session);
  } catch (error) {
    if (!session.cleaned && session.generation === playbackGeneration) {
      emit(video, 'error', { error, recoverable: true });
    }
    throw error;
  }
}

function setPlaybackQuality(level) {
  const hls = activeSession?.hls;
  if (!hls) return false;
  const value = Number(level);
  if (!Number.isInteger(value) || value < 0) {
    hls.currentLevel = -1;
    hls.nextLevel = -1;
  } else if (value < hls.levels.length) {
    hls.nextLevel = value;
  } else {
    return false;
  }
  emit(activeSession.video, 'quality', {
    currentLevel: value < 0 ? -1 : value,
    auto: value < 0,
  });
  return true;
}

function srtToVtt(text) {
  return `WEBVTT\n\n${text
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

async function remoteSubtitle(subtitle) {
  const format = String(subtitle.format || '').toLowerCase();
  if (!['vtt', 'srt', ''].includes(format)) throw new Error('当前仅支持 VTT 和 SRT 字幕');
  const response = await fetch(subtitle.url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`字幕加载失败（${response.status}）`);
  let text = await response.text();
  if (format === 'srt' || /\.srt(?:$|\?)/i.test(subtitle.url)) text = srtToVtt(text);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
  subtitleUrls.push(url);
  return url;
}

async function loadSubtitle(video, subtitle) {
  [...video.querySelectorAll('track')].forEach(track => track.remove());
  if (!subtitle) {
    [...video.textTracks].forEach(track => { track.mode = 'disabled'; });
    return;
  }

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = subtitle.name || subtitle.lang || '字幕';
  track.srclang = subtitle.lang || 'zh';
  track.src = subtitle.localUrl || await remoteSubtitle(subtitle);
  track.default = true;
  video.appendChild(track);
  track.addEventListener('load', () => {
    [...video.textTracks].forEach(item => {
      item.mode = item === track.track ? 'showing' : 'disabled';
    });
  }, { once: true });
}

async function localSubtitle(file) {
  if (!/\.(vtt|srt)$/i.test(file.name)) throw new Error('请选择 VTT 或 SRT 字幕文件');
  if (file.size > 5_000_000) throw new Error('字幕文件不能超过 5 MB');
  let text = await file.text();
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
  subtitleUrls.forEach(URL.revokeObjectURL);
  subtitleUrls = [];
}

export {
  loadSubtitle,
  localSubtitle,
  playStream,
  setPlaybackQuality,
  stopStream,
};
