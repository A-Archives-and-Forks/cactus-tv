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
  };

  let hideTimer = 0;
  let gestureTimer = 0;
  let scrubbing = false;
  let retryHandler = null;
  let state = 'idle';
  let lastPointerActivity = 0;
  let timeFrame = 0;
  let diagnosticsVisible = false;
  let diagnosticsData = null;
  let locked = false;
  const coarsePointer = matchMedia('(pointer: coarse)');

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
    if (locked || video.paused || state !== 'playing') return;
    hideTimer = window.setTimeout(() => {
      closeTools();
      setControlsVisible(false);
    }, delay);
  }

  function showControls(persist = false) {
    if (locked) return;
    setControlsVisible(true);
    clearTimeout(hideTimer);
    if (!persist) scheduleHide();
  }

  function hideControls() {
    if (locked) return;
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
    shell.classList.toggle('is-playing', nextState === 'playing');
    if (nextState === 'playing') showControls();
    else if (loading || nextState === 'paused' || nextState === 'ended') showControls(true);
  }

  function updatePlayButton() {
    const playing = !video.paused && !video.ended;
    setIcon(ui.play, playing ? 'pause' : 'play');
    ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    ui.centerPlay.classList.toggle('hidden', playing || ['loading', 'buffering', 'reconnecting', 'recovering'].includes(state));
    ui.centerPlay.innerHTML = svgIcon('play');
  }

  function updateTime() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
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

  function seekBy(seconds) {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = clamp(video.currentTime + seconds, 0, video.duration);
    ui.gesture.textContent = seconds > 0 ? `快进 ${seconds} 秒` : `快退 ${Math.abs(seconds)} 秒`;
    ui.gesture.classList.remove('hidden');
    clearTimeout(gestureTimer);
    gestureTimer = window.setTimeout(() => ui.gesture.classList.add('hidden'), 700);
    showControls();
  }

  function updateVolume() {
    const muted = video.muted || video.volume === 0;
    setIcon(ui.mute, muted ? 'muted' : 'volume');
    ui.mute.setAttribute('aria-label', muted ? '取消静音' : '静音');
    ui.volume.value = String(muted ? 0 : video.volume);
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
    if (locked) {
      clearTimeout(hideTimer);
      setControlsVisible(false);
      diagnosticsVisible = false;
      ui.diagnosticsPanel?.classList.add('hidden');
      ui.diagnostics?.classList.remove('active');
    } else showControls();
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
      `缓冲  ${d.buffer ?? 0}s`,
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
      scheduleHide(5500);
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

  ui.play.addEventListener('click', togglePlay);
  ui.centerPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', () => {
    if (locked) return;
    if (coarsePointer.matches) {
      shell.classList.contains('controls-visible') ? hideControls() : showControls();
    } else togglePlay();
  });
  video.addEventListener('dblclick', event => {
    if (locked) return;
    const bounds = video.getBoundingClientRect();
    seekBy(event.clientX < bounds.left + bounds.width / 2 ? -10 : 10);
  });

  ui.progress.addEventListener('input', () => {
    scrubbing = true;
    const ratio = Number(ui.progress.value) / 1000;
    ui.played.style.width = `${ratio * 100}%`;
    ui.current.textContent = formatClock((video.duration || 0) * ratio);
    showControls(true);
  });
  ui.progress.addEventListener('change', () => {
    if (Number.isFinite(video.duration)) video.currentTime = video.duration * Number(ui.progress.value) / 1000;
    scrubbing = false;
    showControls();
  });
  ui.progress.addEventListener('pointerup', () => { scrubbing = false; });

  ui.mute.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.7;
    updateVolume();
  });
  ui.volume.addEventListener('input', () => {
    video.volume = Number(ui.volume.value);
    video.muted = video.volume === 0;
    updateVolume();
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
    else scheduleHide(5500);
  });
  ui.diagnostics?.addEventListener('click', toggleDiagnostics);
  document.addEventListener('fullscreenchange', updateFullscreen);
  document.addEventListener('webkitfullscreenchange', updateFullscreen);
  video.addEventListener('webkitbeginfullscreen', updateFullscreen);
  video.addEventListener('webkitendfullscreen', updateFullscreen);
  dialog.addEventListener('close', async () => {
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
    if (locked) return;
    const now = performance.now();
    if (now - lastPointerActivity < 120) return;
    lastPointerActivity = now;
    showControls();
  });
  shell.addEventListener('pointerdown', event => {
    if (locked || event.target.closest('#playerToolsToggle,#playerLock')) return;
    showControls();
  });
  dialog.addEventListener('pointerdown', event => {
    if (!dialog.classList.contains('tools-open')) return;
    if (event.target.closest('#playerTools,#playerToolsToggle')) return;
    closeTools();
    showControls();
  });
  shell.addEventListener('mouseleave', () => { if (!video.paused && state === 'playing') hideControls(); });
  dialog.addEventListener('focusin', event => {
    if (locked) return;
    showControls(!coarsePointer.matches);
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
      ArrowUp: () => { video.volume = clamp(video.volume + 0.1, 0, 1); video.muted = false; updateVolume(); },
      ArrowDown: () => { video.volume = clamp(video.volume - 0.1, 0, 1); updateVolume(); },
    };
    const action = actions[key];
    if (!action || target.tagName === 'SELECT') return;
    event.preventDefault(); action();
  });

  video.addEventListener('play', updatePlayButton);
  video.addEventListener('pause', updatePlayButton);
  video.addEventListener('ended', updatePlayButton);
  video.addEventListener('timeupdate', scheduleTimeUpdate);
  video.addEventListener('durationchange', scheduleTimeUpdate);
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
  updateVolume();
  updateTime();
  showControls(true);

  return {
    reset() {
      clearTimeout(hideTimer); clearTimeout(gestureTimer);
      if (timeFrame) cancelAnimationFrame(timeFrame);
      timeFrame = 0; diagnosticsData = null; diagnosticsVisible = false;
      setLocked(false);
      closeTools();
      message.classList.add('hidden');
      ui.gesture.classList.add('hidden');
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
