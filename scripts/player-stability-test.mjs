import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = path => fs.readFileSync(path, 'utf8');
const player = read('public/js/player.js');
const app = read('public/js/app.js');
const ui = read('public/js/player-ui.js');
const index = read('public/index.html');
const legacy = read('public/js/app-legacy.js');

function block(source, marker, nextMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `缺少代码块：${marker}`);
  const end = nextMarker ? source.indexOf(nextMarker, start + marker.length) : source.length;
  assert.notEqual(end, -1, `缺少代码块结尾：${nextMarker}`);
  return source.slice(start, end);
}

const seekBlock = block(player, 'function seekStream(', '\nfunction applyResume(');
assert.ok(seekBlock.includes('video.currentTime = target'), '普通拖拽必须交给媒体元素 currentTime');
assert.ok(!seekBlock.includes('.stopLoad('), '普通拖拽不得 stopLoad，避免重复装载竞态');
assert.ok(seekBlock.includes('if (session.hlsLoadingStopped)'), '仅显式停止过的 loader 才能重启');

const throughputBlock = block(player, 'function recordActiveThroughput(', '\nasync function playWithHls(');
assert.ok(!throughputBlock.includes('nextAutoLevel'), '吞吐采样不得越权主动抬升清晰度');

assert.ok(player.includes("consumeRecoveryBudget(session, 'networkRecoveryTimestamps', 2, 90_000)"), '网络恢复必须限频');
assert.ok(player.includes("consumeRecoveryBudget(session, 'mediaRecoveryTimestamps', 1, 90_000)"), '解码恢复必须限频');
assert.ok(player.includes('session.hasPresentedFrame = true'), '必须以实际呈现帧作为稳定进度依据');
assert.ok(player.includes('session.seekRecoveryPending'), '拖拽后必须等待目标帧确认');
assert.ok(player.includes('spanUsable ? saneSpan : saneSum'), '异常分片起始时间必须回退到 EXTINF 时长总和');
assert.ok(player.includes('MAX_REASONABLE_VOD_DURATION = 12 * 60 * 60'), '必须拦截 26/40 小时异常时间轴');

const timeUpdateBlock = block(app, "els.player.addEventListener('timeupdate'", "els.player.addEventListener('cactus:position'");
assert.ok(timeUpdateBlock.includes('hasConfirmedPosition'), '历史进度必须使用已确认视频帧');
assert.ok(!timeUpdateBlock.includes('currentPlayback.lastStablePosition = playerPosition'), '音频时钟不得覆盖稳定视频进度');
assert.ok(app.includes("els.player.addEventListener('cactus:durationAnomaly'"), '应用层必须处理异常时间轴');
assert.ok(app.includes('MAX_SAME_CANDIDATE_RECOVERIES = 2'), '同线路重建必须有上限');
assert.ok(app.includes('RECOVERY_WINDOW_MS = 90_000'), '恢复上限必须按时间窗口计算');

assert.ok(ui.includes('progressCommittedDuringPointer'), '进度条必须处理 change/pointerup 双提交');
assert.ok(ui.includes('lastProgressPointerCommitAt'), '进度条必须抑制事件顺序造成的重复 seek');
assert.ok(ui.includes('current > 12 * 60 * 60'), 'UI 不得展示 26/40 小时异常进度');
assert.ok(ui.includes("if (event.detail?.recoverable !== false) { setState('recovering'); return; }"), '可恢复错误不得先闪硬错误');

assert.match(index, /app\.js\?v=1\.3\.0/);
assert.match(index, /app-legacy\.js\?v=1\.3\.0/);
assert.ok(legacy.length > 100_000, '旧浏览器兼容包疑似未重建');

// Mirror the production playlist-duration decision with malformed start offsets.
const finiteDuration = value => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
};
const MAX_REASONABLE_VOD_DURATION = 12 * 60 * 60;
const MAX_REASONABLE_SEGMENT_DURATION = 20 * 60;
function robustPlaylistDuration(details) {
  const direct = finiteDuration(details?.totalduration);
  const fragments = Array.isArray(details?.fragments) ? details.fragments : [];
  const durations = fragments.map(fragment => finiteDuration(fragment?.duration)).filter(Boolean);
  if (!durations.length) return direct && direct <= MAX_REASONABLE_VOD_DURATION ? direct : 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const segmentCeiling = Math.max(30, Math.min(MAX_REASONABLE_SEGMENT_DURATION, median * 20 || MAX_REASONABLE_SEGMENT_DURATION));
  const sane = durations.filter(duration => duration <= segmentCeiling);
  if (sane.length < Math.max(2, Math.ceil(durations.length * 0.85))) return 0;
  const summed = sane.reduce((sum, duration) => sum + duration, 0);
  const starts = fragments.map(fragment => ({ start: Number(fragment?.start), duration: finiteDuration(fragment?.duration) }))
    .filter(fragment => Number.isFinite(fragment.start) && fragment.duration > 0);
  const span = starts.length ? Math.max(...starts.map(fragment => fragment.start + fragment.duration)) - Math.min(...starts.map(fragment => fragment.start)) : 0;
  const saneSum = finiteDuration(summed);
  const saneSpan = finiteDuration(span);
  const spanUsable = saneSpan > 0 && saneSpan <= MAX_REASONABLE_VOD_DURATION
    && (!saneSum || Math.abs(saneSpan - saneSum) <= Math.max(20, saneSum * 0.12));
  const computed = spanUsable ? saneSpan : saneSum;
  if (!computed || computed > MAX_REASONABLE_VOD_DURATION) return 0;
  return computed;
}
const wrapped = Array.from({ length: 600 }, (_, index) => ({ start: 95_443.72 + index * 6, duration: 6 }));
assert.equal(robustPlaylistDuration({ totalduration: 99_043.72, fragments: wrapped }), 3600, 'PTS 起始偏移不得制造 27 小时时长');
const ordinary = Array.from({ length: 600 }, (_, index) => ({ start: index * 6, duration: 6 }));
assert.equal(robustPlaylistDuration({ totalduration: 3600, fragments: ordinary }), 3600, '正常播放列表时长计算错误');

console.log('播放器稳定性静态测试通过：拖拽单提交、可信时长、帧确认进度、有限恢复与版本缓存均已检查。');
