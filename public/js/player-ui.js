import { setPlaybackQuality } from './player.js?v=0.4.0';

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
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
}

export function createPlayerUI({ dialog, shell, video, message, retryButton }) {
  const ui = {
    controls: shell.querySelector('#playerControls'),
    centerPlay: shell.querySelector('#centerPlay'),
    loading: shell.querySelector('#playerLoading'),
    loadingText: shell.querySelector('#playerLoadingText'),
    play: shell.querySelector('#playerPlayToggle'),
    current: shell.querySelector('#playerCurrentTime'),
    duration: shell.querySelector('#playerDuration'),
    progress: shell.querySelector('#playerProgress'),
    played: shell.querySelector('#playerPlayed'),
    buffered: shell.querySelector('#playerBuffered'),
    mute: shell.querySelector('#playerMute'),
    volume: shell.querySelector('#playerVolume'),
    speed: shell.querySelector('#playerSpeed'),
    quality: shell.querySelector('#playerQuality'),
    pip: shell.querySelector('#playerPip'),
    fullscreen: shell.querySelector('#playerFullscreen'),
    gesture: shell.querySelector('#playerGesture'),
  };

  let hideTimer = 0;
  let gestureTimer = 0;
  let scrubbing = false;
  let retryHandler = null;
  let state = 'idle';
  let lastPointerActivity = 0;

  const setIcon = (button, icon) => { button.innerHTML = svgIcon(icon); };

  function showControls(persist = false) {
    shell.classList.add('controls-visible');
    clearTimeout(hideTimer);
    if (!persist && !video.paused && state === 'playing') {
      hideTimer = window.setTimeout(() => shell.classList.remove('controls-visible'), 2600);
    }
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
    }
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

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shell.requestFullscreen) await shell.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    } catch {}
    showControls();
  }

  function updateFullscreen() {
    setIcon(ui.fullscreen, document.fullscreenElement ? 'exitFullscreen' : 'fullscreen');
    ui.fullscreen.setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '全屏');
  }

  ui.play.addEventListener('click', togglePlay);
  ui.centerPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', () => {
    if (matchMedia('(pointer: coarse)').matches) {
      shell.classList.contains('controls-visible') ? shell.classList.remove('controls-visible') : showControls();
    } else {
      togglePlay();
    }
  });
  video.addEventListener('dblclick', event => {
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
  ui.speed.addEventListener('change', () => {
    video.playbackRate = Number(ui.speed.value) || 1;
    showControls();
  });
  ui.quality.addEventListener('change', () => {
    setPlaybackQuality(Number(ui.quality.value));
    showControls();
  });
  ui.fullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreen);

  if (!document.pictureInPictureEnabled || !video.requestPictureInPicture) {
    ui.pip.classList.add('hidden');
  } else {
    ui.pip.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch {}
      showControls();
    });
  }

  shell.addEventListener('pointermove', () => {
    const now = performance.now();
    if (now - lastPointerActivity < 120) return;
    lastPointerActivity = now;
    showControls();
  });
  shell.addEventListener('pointerdown', () => showControls());
  shell.addEventListener('mouseleave', () => {
    if (!video.paused && state === 'playing') shell.classList.remove('controls-visible');
  });
  shell.addEventListener('keydown', event => {
    if (!dialog.open || /INPUT|SELECT|BUTTON/.test(event.target.tagName)) return;
    const actions = {
      ' ': togglePlay,
      k: togglePlay,
      K: togglePlay,
      ArrowLeft: () => seekBy(-5),
      j: () => seekBy(-10),
      J: () => seekBy(-10),
      ArrowRight: () => seekBy(5),
      l: () => seekBy(10),
      L: () => seekBy(10),
      m: () => ui.mute.click(),
      M: () => ui.mute.click(),
      f: toggleFullscreen,
      F: toggleFullscreen,
      ArrowUp: () => { video.volume = clamp(video.volume + 0.1, 0, 1); video.muted = false; updateVolume(); },
      ArrowDown: () => { video.volume = clamp(video.volume - 0.1, 0, 1); updateVolume(); },
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  video.addEventListener('play', updatePlayButton);
  video.addEventListener('pause', updatePlayButton);
  video.addEventListener('ended', updatePlayButton);
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('durationchange', updateTime);
  video.addEventListener('progress', updateTime);
  video.addEventListener('volumechange', updateVolume);
  video.addEventListener('ratechange', () => { ui.speed.value = String(video.playbackRate); });

  video.addEventListener('cactus:state', event => setState(event.detail.state));
  video.addEventListener('cactus:levels', event => {
    const levels = event.detail.levels || [];
    ui.quality.innerHTML = '<option value="-1">自动</option>'
      + levels.map(level => `<option value="${level.index}">${level.label}</option>`).join('');
    ui.quality.disabled = levels.length === 0;
    ui.quality.closest('.player-select-wrap')?.classList.toggle('hidden', levels.length === 0);
  });
  video.addEventListener('cactus:quality', event => {
    ui.quality.value = String(event.detail.auto ? -1 : event.detail.currentLevel);
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
  updateVolume();
  updateTime();
  showControls(true);

  return {
    reset() {
      clearTimeout(hideTimer);
      clearTimeout(gestureTimer);
      message.classList.add('hidden');
      ui.gesture.classList.add('hidden');
      ui.quality.innerHTML = '<option value="-1">自动</option>';
      ui.quality.disabled = true;
      ui.quality.closest('.player-select-wrap')?.classList.add('hidden');
      ui.speed.value = '1';
      video.playbackRate = 1;
      setState('loading');
      updatePlayButton();
      updateTime();
      shell.classList.add('controls-visible');
    },
    focus() {
      shell.focus({ preventScroll: true });
    },
    setRetry(handler) {
      retryHandler = handler;
    },
    showError(error) {
      setState('error');
      message.querySelector('span').textContent = error?.message || String(error || '播放失败');
      message.classList.remove('hidden');
      showControls(true);
    },
  };
}
