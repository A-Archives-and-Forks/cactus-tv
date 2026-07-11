const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function formatClock(seconds = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

function svgIcon(name) {
  const icons = {
    play: '<path d="m9 6 10 6-10 6V6Z" fill="currentColor"/>',
    pause: '<path d="M8 6h3v12H8V6Zm5 0h3v12h-3V6Z" fill="currentColor"/>',
    volume: '<path d="M4 10v4h4l5 4V6L8 10H4Zm11.5-.8a4 4 0 0 1 0 5.6m2-7.6a7 7 0 0 1 0 9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    muted: '<path d="M4 10v4h4l5 4V6L8 10H4Zm11.5-.5 4 5m0-5-4 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    fullscreen: '<path d="M8 4H4v4m12-4h4v4M8 20H4v-4m12 4h4v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    exitFullscreen: '<path d="M4 8h4V4m12 4h-4V4M4 16h4v4m12-4h-4v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    sliders: '<path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10v6m0-9h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    lock: '<rect x="6" y="10" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    unlock: '<rect x="6" y="10" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 10V7.5a3.5 3.5 0 0 0-6.55-1.72" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
}

export function createPlayerUI({
  dialog, shell, video, message, retryButton,
  setQuality = () => false,
  setAudioTrack = () => false,
  setSubtitleTrack = () => false,
}) {
  const ui = {
    controls: shell.querySelector('#playerControls'),
    centerPlay: shell.querySelector('#centerPlay'),
    loading: shell.querySelector('#playerLoading'),
    loadingText: shell.querySelector('#playerLoadingText'),
    play: shell.querySelector('#playerPlayToggle'),
    prev: shell.querySelector('#playerPrev'),
    next: shell.querySelector('#playerNext'),
    current: shell.querySelector('#playerCurrentTime'),
    duration: shell.querySelector('#playerDuration'),
    progress: shell.querySelector('#playerProgress'),
    buffered: shell.querySelector('#playerBuffered'),
    played: shell.querySelector('#playerPlayed'),
    mute: shell.querySelector('#playerMute'),
    volume: shell.querySelector('#playerVolume'),
    speed: shell.querySelector('#playerSpeed'),
    quality: shell.querySelector('#playerQuality'),
    audio: shell.querySelector('#playerAudioTrack'),
    embeddedSubtitle: shell.querySelector('#playerEmbeddedSubtitle'),
    pip: shell.querySelector('#playerPip'),
    fullscreen: shell.querySelector('#playerFullscreen'),
    lock: shell.querySelector('#playerLock'),
    tools: shell.querySelector('#playerToolsToggle'),
    toolsPanel: dialog.querySelector('#playerTools'),
    toolsClose: dialog.querySelector('#playerToolsClose'),
    diagnostics: shell.querySelector('#playerDiagnostics'),
    diagnosticsPanel: shell.querySelector('#playerDiagnosticsPanel'),
    gesture: shell.querySelector('#playerGesture'),
    brightnessShade: shell.querySelector('#playerBrightnessShade'),
  };

  let hideTimer = 0;
  let gestureTimer = 0;
  let gestureFadeTimer = 0;
  let gestureHideToken = 0;
  let longPressTimer = 0;
  let scrubbing = false;
  let retryHandler = null;
  let state = 'idle';
  let lastPointerActivity = 0;
  let timeFrame = 0;
  let diagnosticsVisible = false;
  let diagnosticsData = null;
  let trustedDuration = 0;
  let locked = false;
  let brightness = (() => { try { return clamp(Number(localStorage.getItem('cactus:player-brightness') || 1), .2, 1); } catch { return 1; } })();
  let pointerSession = null;
  let suppressClickUntil = 0;
  let gestureFrame = 0;
  let pendingGestureUpdate = null;
  let singleTapTimer = 0;
  let lastTapTime = 0;
  let lastTapZone = '';
  let lastDoubleTapAt = 0;
  let lastDoubleTapZone = '';
  let doubleTapSeekTotal = 0;
  let doubleTapResetTimer = 0;
  const coarsePointer = matchMedia('(pointer: coarse)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const LONG_PRESS_MS = 420;
  const GESTURE_THRESHOLD = 16;
  const AXIS_LOCK_RATIO = 1.38;
  const DOUBLE_TAP_MS = 270;
  const persistPlayerPreference = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };
  const effectiveDuration = () => {
    const coreDuration = Number(video.__cactusTrustedDuration || trustedDuration || 0);
    if (Number.isFinite(coreDuration) && coreDuration > 0) return coreDuration;
    const nativeDuration = Number(video.duration || 0);
    return Number.isFinite(nativeDuration) && nativeDuration > 0 && nativeDuration < 12 * 60 * 60 ? nativeDuration : 0;
  };
  const clampedCurrentTime = () => {
    const duration = effectiveDuration();
    const current = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
    return duration ? clamp(current, 0, duration) : current;
  };

  const setIcon = (button, icon) => { if (button) button.innerHTML = svgIcon(icon); };

  function setControlsVisible(visible) {
    shell.classList.toggle('controls-visible', visible);
    dialog.classList.toggle('controls-visible', visible);
  }

  function closeTools({ restoreFocus = false } = {}) {
    const wasOpen = dialog.classList.contains('tools-open');
    dialog.classList.remove('tools-open');
    ui.tools?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && wasOpen) ui.tools?.focus({ preventScroll: true });
  }

  function scheduleHide(delay = 2800) {
    clearTimeout(hideTimer);
    if (dialog.classList.contains('tools-open')) return;
    if (['loading', 'buffering', 'reconnecting', 'recovering', 'error'].includes(state)) return;
    hideTimer = window.setTimeout(() => {
      closeTools();
      setControlsVisible(false);
    }, delay);
  }

  function showControls(persist = false) {
    setControlsVisible(true);
    clearTimeout(hideTimer);
    if (!persist) scheduleHide();
  }

  function hideControls() {
    clearTimeout(hideTimer);
    closeTools();
    setControlsVisible(false);
  }

  function setState(nextState) {
    state = nextState;
    shell.dataset.state = nextState;
    const loading = ['loading', 'buffering', 'reconnecting', 'recovering'].includes(nextState);
    ui.loading.classList.toggle('hidden', !loading);
    ui.loadingText.textContent = nextState === 'reconnecting'
      ? '网络波动，正在重连…'
      : nextState === 'recovering'
        ? '正在恢复播放…'
        : nextState === 'buffering'
          ? '缓冲中…'
          : '正在加载…';
    const activePlayback = ['playing', 'buffering', 'reconnecting', 'recovering'].includes(nextState);
    shell.classList.toggle('is-playing', activePlayback);
    if (nextState === 'playing') {
      if (!locked && shell.classList.contains('controls-visible')) scheduleHide();
    } else if (nextState === 'paused') showControls();
    else if (nextState === 'ended') showControls(true);
    else if (nextState === 'loading' && !video.currentTime) showControls(true);
  }

  function updatePlayButton() {
    const playing = !video.paused && !video.ended;
    setIcon(ui.play, playing ? 'pause' : 'play');
    ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    ui.centerPlay.classList.toggle('hidden', playing || ['loading', 'buffering', 'reconnecting', 'recovering'].includes(state));
    ui.centerPlay.innerHTML = svgIcon('play');
  }

  function updateTime() {
    const duration = effectiveDuration();
    const current = clampedCurrentTime();
    ui.current.textContent = formatClock(current);
    ui.duration.textContent = formatClock(duration);
    if (!scrubbing) {
      const value = duration ? current / duration : 0;
      ui.progress.value = String(Math.round(value * 1000));
      ui.played.style.width = `${value * 100}%`;
    }
    if (duration && video.buffered.length) {
      let bufferedEnd = 0;
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= current + 1) bufferedEnd = video.buffered.end(index);
      }
      ui.buffered.style.width = `${clamp(bufferedEnd / duration, 0, 1) * 100}%`;
    } else ui.buffered.style.width = '0%';
  }

  function scheduleTimeUpdate() {
    if (timeFrame) return;
    timeFrame = requestAnimationFrame(() => { timeFrame = 0; updateTime(); });
  }

  function togglePlay() {
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
    showControls();
  }

  function hideGesture(delay = 0, fadeDuration = 170) {
    clearTimeout(gestureTimer);
    clearTimeout(gestureFadeTimer);
    const token = ++gestureHideToken;
    gestureTimer = window.setTimeout(() => {
      if (token !== gestureHideToken) return;
      ui.gesture.classList.add('is-fading');
      gestureFadeTimer = window.setTimeout(() => {
        if (token !== gestureHideToken) return;
        ui.gesture.classList.add('hidden');
        ui.gesture.classList.remove('is-fading');
        ui.gesture.removeAttribute('data-kind');
      }, fadeDuration);
    }, Math.max(0, delay));
  }

  function showGesture(content, duration = 650, kind = 'default') {
    gestureHideToken += 1;
    clearTimeout(gestureTimer);
    clearTimeout(gestureFadeTimer);
    if (typeof content === 'string') {
      ui.gesture.textContent = content;
    } else {
      const label = String(content?.label || '');
      const detail = String(content?.detail || '');
      const progress = Number(content?.progress);
      ui.gesture.innerHTML = `<strong>${label}</strong>${detail ? `<small>${detail}</small>` : ''}${Number.isFinite(progress) ? `<span class="player-gesture-meter"><i style="width:${clamp(progress, 0, 1) * 100}%"></i></span>` : ''}`;
    }
    ui.gesture.dataset.kind = kind;
    ui.gesture.classList.remove('hidden', 'is-fading');
    if (duration > 0) hideGesture(duration);
  }

  function showTapRipple(x, y, direction) {
    const ripple = document.createElement('span');
    ripple.className = `player-tap-ripple player-tap-ripple-${direction}`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.textContent = direction === 'left' ? '−10' : direction === 'right' ? '+10' : '⏯';
    shell.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    window.setTimeout(() => ripple.remove(), 850);
  }

  function applyBrightness(value, persist = false) {
    brightness = clamp(value, 0.2, 1);
    if (ui.brightnessShade) ui.brightnessShade.style.opacity = String((1 - brightness) * 0.82);
    if (persist) persistPlayerPreference('cactus:player-brightness', brightness.toFixed(3));
  }

  function seekBy(seconds) {
    const duration = effectiveDuration();
    if (!duration) return;
    video.currentTime = clamp(clampedCurrentTime() + seconds, 0, duration);
    showGesture({ label: seconds > 0 ? `快进 ${seconds} 秒` : `快退 ${Math.abs(seconds)} 秒`, detail: formatClock(video.currentTime) }, 700);
    showControls();
  }

  function updateVolume() {
    const muted = video.muted || video.volume === 0;
    setIcon(ui.mute, muted ? 'muted' : 'volume');
    ui.mute.setAttribute('aria-label', muted ? '取消静音' : '静音');
    ui.volume.value = String(muted ? 0 : video.volume);
  }

  function applyVolume(value, { persist = false } = {}) {
    const next = clamp(Number(value) || 0, 0, 1);
    try {
      video.volume = next;
      video.muted = next === 0;
    } catch {}
    updateVolume();
    const actual = video.muted ? 0 : clamp(Number(video.volume) || 0, 0, 1);
    if (persist) persistPlayerPreference('cactus:player-volume', actual.toFixed(3));
    return actual;
  }

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement || video.webkitDisplayingFullscreen);
  }

  async function toggleFullscreen() {
    closeTools();
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } catch {}
      showControls();
      return;
    }

    let entered = false;
    for (const target of [dialog, shell]) {
      const request = target.requestFullscreen || target.webkitRequestFullscreen;
      if (!request) continue;
      try {
        await request.call(target);
        entered = true;
        break;
      } catch {}
    }
    if (!entered && video.webkitEnterFullscreen) {
      try { video.webkitEnterFullscreen(); entered = true; } catch {}
    }
    if (entered) {
      try { await screen.orientation?.lock?.('landscape'); } catch {}
    }
    showControls();
  }

  function updateFullscreen() {
    const active = isFullscreen();
    dialog.classList.toggle('is-fullscreen', active);
    setIcon(ui.fullscreen, active ? 'exitFullscreen' : 'fullscreen');
    ui.fullscreen?.setAttribute('aria-label', active ? '退出全屏' : '全屏');
    ui.fullscreen?.setAttribute('title', active ? '退出全屏' : '全屏');
    closeTools();
    if (!active) {
      try { screen.orientation?.unlock?.(); } catch {}
      if (locked) setLocked(false);
    }
    showControls();
  }

  function setLocked(nextLocked) {
    locked = Boolean(nextLocked);
    dialog.classList.toggle('player-locked', locked);
    shell.classList.toggle('controls-locked', locked);
    closeTools();
    setIcon(ui.lock, locked ? 'lock' : 'unlock');
    ui.lock?.setAttribute('aria-label', locked ? '解锁播放器' : '锁定播放器');
    ui.lock?.setAttribute('title', locked ? '解锁播放器' : '锁定播放器');
    diagnosticsVisible = false;
    ui.diagnosticsPanel?.classList.add('hidden');
    ui.diagnostics?.classList.remove('active');
    showControls();
  }

  function toggleLock() {
    setLocked(!locked);
  }

  function renderDiagnostics() {
    if (!diagnosticsData || !ui.diagnosticsPanel) return;
    const d = diagnosticsData;
    const mbps = d.bandwidth ? `${(d.bandwidth / 1_000_000).toFixed(2)} Mbps` : '—';
    const dropped = d.total ? `${d.dropped}/${d.total}` : String(d.dropped || 0);
    ui.diagnosticsPanel.textContent = [
      `引擎  ${d.engine || '—'}`,
      `状态  ${d.state || '—'}`,
      `画面  ${d.resolution || '—'}`,
      `带宽  ${mbps}`,
      `缓冲  ${d.buffer ?? 0}s / 目标 ${d.bufferTarget || '—'}s`,
      `首帧  ${d.startupMs ? `${d.startupMs}ms` : '—'}`,
      `丢帧  ${dropped}`,
      `卡顿  ${d.stalls || 0}`,
      `域名  ${d.urlHost || '—'}`,
    ].join('\n');
  }

  function toggleDiagnostics() {
    diagnosticsVisible = !diagnosticsVisible;
    ui.diagnosticsPanel?.classList.toggle('hidden', !diagnosticsVisible);
    ui.diagnostics?.classList.toggle('active', diagnosticsVisible);
    renderDiagnostics();
    showControls(true);
  }

  function toggleTools() {
    if (locked) return;
    const opening = !dialog.classList.contains('tools-open');
    dialog.classList.toggle('tools-open', opening);
    ui.tools?.setAttribute('aria-expanded', String(opening));
    if (opening) {
      showControls(true);
      scheduleHide(2800);
      if (!coarsePointer.matches) requestAnimationFrame(() => ui.toolsPanel?.querySelector('select,button,input')?.focus({ preventScroll: true }));
    } else showControls();
  }

  function visibleFocusables() {
    return [...dialog.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]')]
      .filter(element => !element.classList.contains('hidden') && element.getClientRects().length > 0);
  }

  function moveFocus(direction) {
    const items = visibleFocusables();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = current < 0 ? 0 : (current + direction + items.length) % items.length;
    items[next].focus({ preventScroll: true });
    showControls(true);
  }

  function requestClose() {
    const event = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(event);
  }

  function clearLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = 0;
  }

  function queueGestureUpdate(callback) {
    pendingGestureUpdate = callback;
    if (gestureFrame) return;
    gestureFrame = requestAnimationFrame(() => {
      gestureFrame = 0;
      const update = pendingGestureUpdate;
      pendingGestureUpdate = null;
      update?.();
    });
  }

  function finishGestureFrame({ flush = false } = {}) {
    if (gestureFrame) cancelAnimationFrame(gestureFrame);
    gestureFrame = 0;
    const update = pendingGestureUpdate;
    pendingGestureUpdate = null;
    if (flush) update?.();
  }

  function finishPointerGesture(event, cancelled = false) {
    const session = pointerSession;
    if (!session || (event && event.pointerId !== session.id)) return;
    clearLongPress();
    finishGestureFrame({ flush: true });
    if (session.mode === 'boost') {
      video.playbackRate = session.previousRate;
      if (cancelled) hideGesture(0);
      else showGesture({ label: `恢复 ${session.previousRate}×`, detail: '长按倍速结束' }, 360, 'boost');
      suppressClickUntil = performance.now() + 450;
    } else if (session.mode === 'seek') {
      if (!cancelled && Number.isFinite(session.previewTime)) video.currentTime = session.previewTime;
      if (cancelled) hideGesture(0);
      else showGesture({ label: '已定位', detail: `${formatClock(session.previewTime || 0)} / ${formatClock(effectiveDuration())}`, progress: (session.previewTime || 0) / Math.max(1, effectiveDuration() || 1) }, 460, 'seek');
      suppressClickUntil = performance.now() + 450;
    } else if (session.mode === 'brightness' || session.mode === 'volume') {
      if (session.mode === 'brightness') applyBrightness(brightness, true);
      else applyVolume(video.muted ? 0 : video.volume, { persist: true });
      hideGesture(cancelled ? 0 : 140, 180);
      suppressClickUntil = performance.now() + 450;
    } else {
      hideGesture(0);
    }
    pointerSession = null;
    try { video.releasePointerCapture?.(session.id); } catch {}
  }

  function beginPointerGesture(event) {
    if (!coarsePointer.matches || event.pointerType === 'mouse' || event.isPrimary === false || event.button !== 0 || locked) return;
    if (pointerSession) finishPointerGesture(null, true);
    const bounds = video.getBoundingClientRect();
    pointerSession = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startVolume: video.muted ? 0 : video.volume,
      startBrightness: brightness,
      startTime: clampedCurrentTime(),
      previewTime: clampedCurrentTime(),
      previousRate: video.playbackRate,
      startedAt: performance.now(),
      startRatio: (event.clientX - bounds.left) / Math.max(1, bounds.width),
      side: event.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right',
      mode: 'pending',
      bounds,
    };
    try { video.setPointerCapture?.(event.pointerId); } catch {}
    clearLongPress();
    longPressTimer = window.setTimeout(() => {
      if (!pointerSession || pointerSession.id !== event.pointerId || pointerSession.mode !== 'pending' || video.paused) return;
      if (Math.abs(pointerSession.startRatio - 0.5) > 0.46) return;
      pointerSession.mode = 'boost';
      pointerSession.previousRate = video.playbackRate;
      video.playbackRate = 2;
      navigator.vibrate?.(10);
      closeTools();
      hideControls();
      showGesture({ label: '2× 倍速播放', detail: '松手恢复原速度' }, 0, 'boost');
      suppressClickUntil = performance.now() + 450;
    }, LONG_PRESS_MS);
  }

  function movePointerGesture(event) {
    const session = pointerSession;
    if (!session || event.pointerId !== session.id) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    const distance = Math.hypot(dx, dy);
    if (session.mode === 'pending' && distance >= GESTURE_THRESHOLD) {
      clearLongPress();
      const horizontal = Math.abs(dx) > Math.abs(dy) * AXIS_LOCK_RATIO;
      const vertical = Math.abs(dy) > Math.abs(dx) * AXIS_LOCK_RATIO;
      const inVerticalEdge = session.startRatio <= 0.38 || session.startRatio >= 0.62;
      if (vertical && inVerticalEdge) session.mode = session.side === 'left' ? 'brightness' : 'volume';
      else if (horizontal) session.mode = 'seek';
      else return;
      closeTools();
      hideControls();
      suppressClickUntil = performance.now() + 450;
    }
    if (session.mode === 'brightness') {
      event.preventDefault();
      const next = session.startBrightness - dy / Math.max(220, session.bounds.height * 0.78);
      applyBrightness(next);
      const currentBrightness = brightness;
      queueGestureUpdate(() => {
        showGesture({ label: `亮度 ${Math.round(currentBrightness * 100)}%`, progress: currentBrightness }, 0, 'brightness');
      });
    } else if (session.mode === 'volume') {
      event.preventDefault();
      const next = clamp(session.startVolume - dy / Math.max(220, session.bounds.height * 0.78), 0, 1);
      const actual = applyVolume(next);
      const blocked = Math.abs(actual - next) > 0.08;
      queueGestureUpdate(() => {
        showGesture({
          label: blocked ? '请使用系统音量键' : `音量 ${Math.round(actual * 100)}%`,
          detail: blocked ? '当前浏览器不允许网页调节设备音量' : '',
          progress: actual,
        }, 0, 'volume');
      });
    } else if (session.mode === 'seek') {
      event.preventDefault();
      const duration = effectiveDuration();
      const normalized = clamp(Math.abs(dx) / Math.max(260, session.bounds.width), 0, 1);
      const elapsed = Math.max(0.08, (performance.now() - session.startedAt) / 1000);
      const velocityBoost = clamp((Math.abs(dx) / elapsed) / 900, 1, 1.8);
      const precision = Math.abs(dy) > session.bounds.height * .22 ? .18 : Math.abs(dy) > session.bounds.height * .1 ? .42 : 1;
      const sweep = clamp(duration * 0.12, 150, 900);
      const delta = Math.sign(dx) * (normalized ** 1.18) * sweep * velocityBoost * precision;
      const preview = clamp(session.startTime + delta, 0, duration || session.startTime + Math.abs(delta));
      session.previewTime = preview;
      queueGestureUpdate(() => {
        const signed = Math.round(preview - session.startTime);
        showGesture({
          label: `${signed >= 0 ? '快进' : '快退'} ${Math.abs(signed)} 秒`,
          detail: `${precision < 1 ? '精细定位 · ' : ''}${formatClock(preview)} / ${formatClock(duration)}`,
          progress: duration ? preview / duration : 0,
        }, 0, 'seek');
      });
    }
  }

  ui.play.addEventListener('click', togglePlay);
  ui.centerPlay.addEventListener('click', togglePlay);
  video.addEventListener('pointerdown', beginPointerGesture);
  video.addEventListener('pointermove', movePointerGesture, { passive: false });
  video.addEventListener('pointerup', event => finishPointerGesture(event, false));
  video.addEventListener('pointercancel', event => finishPointerGesture(event, true));
  video.addEventListener('lostpointercapture', event => finishPointerGesture(event, true));
  video.addEventListener('contextmenu', event => { if (coarsePointer.matches) event.preventDefault(); });
  video.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!coarsePointer.matches) {
      if (!locked) togglePlay();
      return;
    }
    if (locked) {
      showControls();
      return;
    }
    const bounds = video.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width);
    const zone = ratio < 0.34 ? 'left' : ratio > 0.66 ? 'right' : 'center';
    const now = performance.now();
    if (now - lastTapTime <= DOUBLE_TAP_MS && zone === lastTapZone) {
      clearTimeout(singleTapTimer);
      singleTapTimer = 0;
      lastTapTime = 0;
      lastTapZone = '';
      navigator.vibrate?.(8);
      showTapRipple(event.clientX - bounds.left, event.clientY - bounds.top, zone);
      if (zone === 'center') {
        doubleTapSeekTotal = 0;
        togglePlay();
      } else {
        if (now - lastDoubleTapAt <= 760 && zone === lastDoubleTapZone) doubleTapSeekTotal += zone === 'left' ? -10 : 10;
        else doubleTapSeekTotal = zone === 'left' ? -10 : 10;
        lastDoubleTapAt = now;
        lastDoubleTapZone = zone;
        clearTimeout(doubleTapResetTimer);
        doubleTapResetTimer = window.setTimeout(() => { doubleTapSeekTotal = 0; lastDoubleTapZone = ''; }, 820);
        { const duration = effectiveDuration(); if (duration) video.currentTime = clamp(clampedCurrentTime() + (zone === 'left' ? -10 : 10), 0, duration); }
        showGesture({ label: doubleTapSeekTotal > 0 ? `快进 ${doubleTapSeekTotal} 秒` : `快退 ${Math.abs(doubleTapSeekTotal)} 秒`, detail: formatClock(video.currentTime) }, 620);
        showControls();
      }
      return;
    }
    lastTapTime = now;
    lastTapZone = zone;
    clearTimeout(singleTapTimer);
    singleTapTimer = window.setTimeout(() => {
      singleTapTimer = 0;
      if (shell.classList.contains('controls-visible')) hideControls();
      else showControls();
    }, DOUBLE_TAP_MS);
  });
  video.addEventListener('dblclick', event => {
    if (locked || coarsePointer.matches) return;
    const bounds = video.getBoundingClientRect();
    seekBy(event.clientX < bounds.left + bounds.width / 2 ? -10 : 10);
  });

  ui.progress.addEventListener('input', () => {
    scrubbing = true;
    const ratio = Number(ui.progress.value) / 1000;
    ui.played.style.width = `${ratio * 100}%`;
    ui.current.textContent = formatClock(effectiveDuration() * ratio);
    showControls(true);
  });
  ui.progress.addEventListener('change', () => {
    { const duration = effectiveDuration(); if (duration) video.currentTime = duration * Number(ui.progress.value) / 1000; }
    scrubbing = false;
    showControls();
  });
  ui.progress.addEventListener('pointerup', () => { scrubbing = false; });

  ui.mute.addEventListener('click', () => {
    if (video.muted || video.volume === 0) applyVolume(video.volume > 0 ? video.volume : 0.7, { persist: true });
    else {
      video.muted = true;
      updateVolume();
    }
  });
  ui.volume.addEventListener('input', () => {
    applyVolume(Number(ui.volume.value), { persist: true });
  });
  ui.speed.addEventListener('change', () => { video.playbackRate = Number(ui.speed.value) || 1; showControls(); });
  ui.quality.addEventListener('change', () => { setQuality(Number(ui.quality.value)); showControls(); });
  ui.audio.addEventListener('change', () => { setAudioTrack(Number(ui.audio.value)); showControls(); });
  ui.embeddedSubtitle.addEventListener('change', () => { setSubtitleTrack(Number(ui.embeddedSubtitle.value)); showControls(); });
  ui.fullscreen.addEventListener('click', toggleFullscreen);
  ui.lock?.addEventListener('click', event => { event.stopPropagation(); toggleLock(); });
  ui.tools?.addEventListener('click', event => { event.stopPropagation(); toggleTools(); });
  ui.toolsClose?.addEventListener('click', () => { closeTools({ restoreFocus: true }); showControls(); });
  ui.toolsPanel?.addEventListener('pointerdown', event => event.stopPropagation());
  ui.toolsPanel?.addEventListener('change', () => {
    if (coarsePointer.matches || isFullscreen()) closeTools();
    showControls();
  });
  ui.toolsPanel?.addEventListener('click', event => {
    if (event.target.closest('#playerToolsClose')) return;
    if (event.target.closest('button')) queueMicrotask(() => { closeTools(); showControls(); });
    else scheduleHide(2800);
  });
  ui.diagnostics?.addEventListener('click', toggleDiagnostics);
  document.addEventListener('fullscreenchange', updateFullscreen);
  document.addEventListener('webkitfullscreenchange', updateFullscreen);
  video.addEventListener('webkitbeginfullscreen', updateFullscreen);
  video.addEventListener('webkitendfullscreen', updateFullscreen);
  dialog.addEventListener('close', async () => {
    finishPointerGesture(null, true);
    hideGesture(0);
    closeTools();
    setLocked(false);
    if (document.fullscreenElement === dialog || document.webkitFullscreenElement === dialog) {
      try {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } catch {}
    }
  });

  if (!document.pictureInPictureEnabled || !video.requestPictureInPicture) ui.pip.classList.add('hidden');
  else ui.pip.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {}
    showControls();
  });

  shell.addEventListener('pointermove', () => {
    if (!finePointer.matches || locked) return;
    const now = performance.now();
    if (now - lastPointerActivity < 120) return;
    lastPointerActivity = now;
    showControls();
  });
  shell.addEventListener('pointerdown', event => {
    if (!finePointer.matches || locked || event.target.closest('#playerToolsToggle,#playerLock')) return;
    showControls();
  });
  dialog.addEventListener('pointerdown', event => {
    if (!dialog.classList.contains('tools-open')) return;
    if (event.target.closest('#playerTools,#playerToolsToggle')) return;
    closeTools();
    showControls();
  });
  shell.addEventListener('mouseleave', () => { if (!video.paused && state === 'playing') hideControls(); });
  dialog.addEventListener('focusin', () => {
    if (locked || !finePointer.matches) return;
    showControls(true);
  });

  dialog.addEventListener('keydown', event => {
    if (!dialog.open && !dialog.hasAttribute('open')) return;
    const key = event.key;
    if (['Escape', 'GoBack', 'BrowserBack'].includes(key) || event.keyCode === 461) {
      event.preventDefault();
      if (locked) setLocked(false);
      else if (dialog.classList.contains('tools-open')) { closeTools({ restoreFocus: true }); showControls(); }
      else requestClose();
      return;
    }
    if (key === 'q' || key === 'Q') { event.preventDefault(); toggleLock(); return; }
    if (key === 'f' || key === 'F') { event.preventDefault(); toggleFullscreen(); return; }
    if (locked) return;
    if (key === 'MediaPlayPause' || key === 'Play' || key === 'Pause') { event.preventDefault(); togglePlay(); return; }
    if (key === 'MediaTrackNext') { event.preventDefault(); ui.next?.click(); return; }
    if (key === 'MediaTrackPrevious') { event.preventDefault(); ui.prev?.click(); return; }
    if (key === 'd' || key === 'D') { event.preventDefault(); toggleDiagnostics(); return; }
    if (key === 'm' || key === 'M') { event.preventDefault(); ui.mute.click(); return; }
    if (key === 'k' || key === 'K') { event.preventDefault(); togglePlay(); return; }

    const target = event.target;
    if (target === shell && (key === 'Enter' || key === 'Select')) {
      event.preventDefault(); togglePlay(); return;
    }
    if (target === shell && key === 'ArrowDown') {
      event.preventDefault(); ui.play.focus({ preventScroll: true }); return;
    }
    if (target === shell && key === 'ArrowUp') {
      event.preventDefault();
      const preferred = [ui.lock, ui.tools, dialog.querySelector('.sheet-close'), ui.diagnostics].find(element => element && !element.disabled && element.offsetParent !== null);
      preferred?.focus({ preventScroll: true });
      return;
    }
    const onControl = /BUTTON|SELECT|INPUT/.test(target.tagName) && target !== ui.progress && target !== ui.volume;
    if (onControl && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      event.preventDefault(); moveFocus(key === 'ArrowLeft' ? -1 : 1); return;
    }
    if (onControl && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault(); moveFocus(key === 'ArrowUp' ? -1 : 1); return;
    }
    const actions = {
      ' ': togglePlay,
      ArrowLeft: () => seekBy(-5),
      j: () => seekBy(-10), J: () => seekBy(-10),
      ArrowRight: () => seekBy(5),
      l: () => seekBy(10), L: () => seekBy(10),
      ArrowUp: () => { applyVolume((video.muted ? 0 : video.volume) + 0.1, { persist: true }); },
      ArrowDown: () => { applyVolume((video.muted ? 0 : video.volume) - 0.1, { persist: true }); },
    };
    const action = actions[key];
    if (!action || target.tagName === 'SELECT') return;
    event.preventDefault(); action();
  });

  window.addEventListener('pointerup', event => finishPointerGesture(event, false), { capture: true });
  window.addEventListener('pointercancel', event => finishPointerGesture(event, true), { capture: true });
  window.addEventListener('blur', () => finishPointerGesture(null, true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') finishPointerGesture(null, true);
  });

  video.addEventListener('play', updatePlayButton);
  video.addEventListener('pause', updatePlayButton);
  video.addEventListener('ended', updatePlayButton);
  video.addEventListener('timeupdate', scheduleTimeUpdate);
  video.addEventListener('durationchange', scheduleTimeUpdate);
  video.addEventListener('cactus:duration', event => {
    const duration = Number(event.detail?.duration || 0);
    if (Number.isFinite(duration) && duration > 0) trustedDuration = duration;
    scheduleTimeUpdate();
  });
  video.addEventListener('progress', scheduleTimeUpdate);
  video.addEventListener('volumechange', updateVolume);
  video.addEventListener('ratechange', () => { ui.speed.value = String(video.playbackRate); });

  video.addEventListener('cactus:state', event => setState(event.detail.state));
  video.addEventListener('cactus:levels', event => {
    const levels = event.detail.levels || [];
    ui.quality.innerHTML = '<option value="-1">自动</option>' + levels.map(level => `<option value="${level.index}">${level.label}</option>`).join('');
    ui.quality.disabled = levels.length === 0;
    ui.quality.closest('.player-select-wrap')?.classList.toggle('hidden', levels.length === 0);
  });
  video.addEventListener('cactus:quality', event => { ui.quality.value = String(event.detail.auto ? -1 : event.detail.currentLevel); });
  video.addEventListener('cactus:audioTracks', event => {
    const tracks = event.detail.tracks || [];
    ui.audio.innerHTML = tracks.map(track => `<option value="${track.index}">${track.label}</option>`).join('');
    ui.audio.disabled = tracks.length < 2;
    ui.audio.closest('.player-select-wrap')?.classList.toggle('hidden', tracks.length < 2);
    if (event.detail.current >= 0) ui.audio.value = String(event.detail.current);
  });
  video.addEventListener('cactus:subtitleTracks', event => {
    const tracks = event.detail.tracks || [];
    ui.embeddedSubtitle.innerHTML = '<option value="-1">内嵌字幕关</option>' + tracks.map(track => `<option value="${track.index}">${track.label}</option>`).join('');
    ui.embeddedSubtitle.disabled = tracks.length === 0;
    ui.embeddedSubtitle.closest('.player-select-wrap')?.classList.toggle('hidden', tracks.length === 0);
    ui.embeddedSubtitle.value = String(event.detail.current ?? -1);
  });
  video.addEventListener('cactus:diagnostics', event => { diagnosticsData = event.detail; if (diagnosticsVisible) renderDiagnostics(); });
  video.addEventListener('cactus:cleanstream', event => {
    const removed = Number(event.detail?.removed || 0);
    if (event.detail?.mode === 'FILTERED' && removed > 0) {
      showGesture({ label: `已跳过 ${removed} 个广告分片`, detail: 'Cactus Clean Stream' }, 1600);
    }
  });
  video.addEventListener('cactus:error', event => {
    setState('error');
    message.querySelector('span').textContent = event.detail.error?.message || '播放失败';
    message.classList.remove('hidden');
    showControls(true);
  });

  retryButton.addEventListener('click', () => retryHandler?.());

  setIcon(ui.play, 'play');
  setIcon(ui.mute, 'volume');
  setIcon(ui.fullscreen, 'fullscreen');
  setIcon(ui.lock, 'unlock');
  setIcon(ui.tools, 'sliders');
  setIcon(ui.diagnostics, 'info');
  try {
    const savedVolume = Number(localStorage.getItem('cactus:player-volume'));
    if (Number.isFinite(savedVolume)) applyVolume(savedVolume);
  } catch {}
  applyBrightness(brightness);
  updateVolume();
  updateTime();
  showControls(true);

  return {
    reset() {
      clearTimeout(hideTimer); clearTimeout(gestureTimer); clearTimeout(gestureFadeTimer); clearTimeout(singleTapTimer); clearTimeout(doubleTapResetTimer); clearLongPress();
      pointerSession = null; suppressClickUntil = 0;
      if (timeFrame) cancelAnimationFrame(timeFrame);
      finishGestureFrame();
      timeFrame = 0; gestureFrame = 0; pendingGestureUpdate = null; lastTapTime = 0; lastTapZone = ''; lastDoubleTapAt = 0; lastDoubleTapZone = ''; doubleTapSeekTotal = 0; diagnosticsData = null; diagnosticsVisible = false; trustedDuration = 0;
      setLocked(false);
      closeTools();
      message.classList.add('hidden');
      ui.gesture.classList.add('hidden');
      ui.gesture.classList.remove('is-fading');
      ui.gesture.removeAttribute('data-kind');
      applyBrightness(brightness);
      ui.diagnosticsPanel?.classList.add('hidden');
      ui.diagnostics?.classList.remove('active');
      ui.quality.innerHTML = '<option value="-1">自动</option>';
      ui.quality.disabled = true;
      ui.quality.closest('.player-select-wrap')?.classList.add('hidden');
      ui.audio.innerHTML = '<option value="-1">默认音轨</option>';
      ui.audio.disabled = true;
      ui.audio.closest('.player-select-wrap')?.classList.add('hidden');
      ui.embeddedSubtitle.innerHTML = '<option value="-1">内嵌字幕关</option>';
      ui.embeddedSubtitle.disabled = true;
      ui.embeddedSubtitle.closest('.player-select-wrap')?.classList.add('hidden');
      ui.speed.value = '1'; video.playbackRate = 1;
      setState('loading'); updatePlayButton(); updateTime(); setControlsVisible(true);
    },
    focus() { shell.focus({ preventScroll: true }); },
    setRetry(handler) { retryHandler = handler; },
    showError(error) {
      setState('error');
      message.querySelector('span').textContent = error?.message || String(error || '播放失败');
      message.classList.remove('hidden');
      showControls(true);
    },
  };
}
