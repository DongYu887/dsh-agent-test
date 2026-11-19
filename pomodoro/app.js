/* 番茄时钟 —— 原生 JavaScript 实现
 *
 * 计时基于「目标结束时间」计算剩余时间，切换后台再回来依然准确。
 * 所有设置与统计保存在浏览器 localStorage 中，无任何外部请求。
 */
(function () {
  'use strict';

  var MODE_CONFIG = {
    focus: { name: '专注', timerName: '专注时间', settingKey: 'focusMinutes' },
    short: { name: '短休息', timerName: '短休息', settingKey: 'shortMinutes' },
    long: { name: '长休息', timerName: '长休息', settingKey: 'longMinutes' }
  };
  var MODE_ORDER = ['focus', 'short', 'long'];
  var DEFAULT_SETTINGS = {
    focusMinutes: 25,
    shortMinutes: 5,
    longMinutes: 15,
    sound: true
  };
  var MINUTES_MIN = 1;
  var MINUTES_MAX = 120;
  var TICK_INTERVAL = 200;
  var RING_RADIUS = 132;
  var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  var STORAGE_KEYS = {
    settings: 'pomodoro.settings.v1',
    stats: 'pomodoro.stats.v1'
  };

  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var stats = { date: '', count: 0 };
  var storageAvailable = true;

  var state = {
    mode: 'focus',
    status: 'idle', // idle | running | paused | done
    totalMs: 0,
    remainingMs: 0,
    endAt: 0,
    intervalId: null,
    timeoutId: null,
    audioCtx: null,
    soundAvailable: true,
    completionKind: null,
    celebrateTimeout: null
  };

  var el = {};
  var confetti = {
    canvas: null,
    ctx: null,
    particles: [],
    rafId: 0,
    running: false,
    lastTime: 0
  };

  /* ---------- 工具 ---------- */

  function clampMinutes(value) {
    var rounded = Math.round(Number(value));
    if (!isFinite(rounded)) {
      return MINUTES_MIN;
    }
    return Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, rounded));
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatClock(ms) {
    var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return pad2(minutes) + ':' + pad2(seconds);
  }

  function todayKey() {
    var now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function prefersReducedMotion() {
    return !!(
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function durationMs(mode) {
    return settings[MODE_CONFIG[mode].settingKey] * 60 * 1000;
  }

  /* ---------- 本地存储 ---------- */

  function detectStorage() {
    try {
      var testKey = '__pomodoro_test__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return true;
    } catch (error) {
      return false;
    }
  }

  function markStorageUnavailable() {
    storageAvailable = false;
    if (el.storageWarning) {
      el.storageWarning.hidden = false;
    }
  }

  function saveSettings() {
    if (!storageAvailable) {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    } catch (error) {
      markStorageUnavailable();
    }
  }

  function loadSettings() {
    var loaded = Object.assign({}, DEFAULT_SETTINGS);
    if (!storageAvailable) {
      return loaded;
    }
    try {
      var raw = window.localStorage.getItem(STORAGE_KEYS.settings);
      if (!raw) {
        return loaded;
      }
      var parsed = JSON.parse(raw);
      MODE_ORDER.forEach(function (mode) {
        var key = MODE_CONFIG[mode].settingKey;
        var value = Number(parsed && parsed[key]);
        if (isFinite(value)) {
          loaded[key] = clampMinutes(value);
        }
      });
      if (parsed && typeof parsed.sound === 'boolean') {
        loaded.sound = parsed.sound;
      }
    } catch (error) {
      // 损坏的存储数据直接回退到默认值，不影响计时功能。
    }
    return loaded;
  }

  function loadStats() {
    var fallback = { date: todayKey(), count: 0 };
    if (!storageAvailable) {
      return fallback;
    }
    try {
      var parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEYS.stats) || 'null');
      var count = Number(parsed && parsed.count);
      if (!parsed || parsed.date !== todayKey() || !isFinite(count) || count < 0) {
        return fallback;
      }
      return { date: todayKey(), count: Math.floor(count) };
    } catch (error) {
      return fallback;
    }
  }

  function saveStats() {
    if (!storageAvailable) {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(stats));
    } catch (error) {
      markStorageUnavailable();
    }
  }

  function ensureToday() {
    if (stats.date === todayKey()) {
      return;
    }
    stats = { date: todayKey(), count: 0 };
    saveStats();
    renderStats();
  }

  /* ---------- 提示音（Web Audio 合成，无音频文件依赖） ---------- */

  function resumeAudio() {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error('AudioContext unsupported');
      }
      if (!state.audioCtx) {
        state.audioCtx = new AudioCtx();
      }
      if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume().then(markAudioAvailable, markAudioUnavailable);
      } else {
        markAudioAvailable();
      }
      return state.audioCtx;
    } catch (error) {
      markAudioUnavailable();
      return null;
    }
  }

  function markAudioUnavailable() {
    if (!state.soundAvailable) {
      updateCompletionAudioNote();
      return;
    }
    state.soundAvailable = false;
    if (el.soundNote) {
      el.soundNote.hidden = false;
    }
    updateCompletionAudioNote();
  }

  function markAudioAvailable() {
    state.soundAvailable = true;
    if (el.soundNote) {
      el.soundNote.hidden = true;
    }
    updateCompletionAudioNote();
  }

  function playChime(kind) {
    var ctx = resumeAudio();
    if (!ctx) {
      return false;
    }
    try {
      var start = ctx.currentTime + 0.03;
      var master = ctx.createGain();
      master.gain.value = 0.15;
      master.connect(ctx.destination);

      var notes =
        kind === 'focus'
          ? [523.25, 659.25, 783.99]
          : kind === 'break'
            ? [659.25, 523.25, 392.0]
            : [587.33, 880.0];

      notes.forEach(function (frequency, index) {
        var noteStart = start + index * 0.15;
        var oscillator = ctx.createOscillator();
        var gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(0.85, noteStart + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.9);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(noteStart);
        oscillator.stop(noteStart + 0.95);
      });

      // 一层很轻的高八度泛音，让提示音更柔和。
      var shimmer = ctx.createOscillator();
      var shimmerGain = ctx.createGain();
      shimmer.type = 'triangle';
      shimmer.frequency.setValueAtTime(kind === 'break' ? 1046.5 : 1318.5, start);
      shimmerGain.gain.setValueAtTime(0.0001, start);
      shimmerGain.gain.exponentialRampToValueAtTime(0.06, start + 0.04);
      shimmerGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.65);
      shimmer.connect(shimmerGain);
      shimmerGain.connect(master);
      shimmer.start(start);
      shimmer.stop(start + 0.7);

      markAudioAvailable();
      return true;
    } catch (error) {
      markAudioUnavailable();
      return false;
    }
  }

  function updateCompletionAudioNote() {
    if (!el.completionNote) {
      return;
    }
    var show = state.completionKind !== null && settings.sound && !state.soundAvailable;
    el.completionNote.hidden = !show;
    if (show) {
      el.completionNote.textContent = '当前浏览器无法播放提示音，请以页面提示为准。';
    }
  }

  /* ---------- 计时器 ---------- */

  function clearTimerIds() {
    if (state.intervalId) {
      window.clearInterval(state.intervalId);
      state.intervalId = null;
    }
    if (state.timeoutId) {
      window.clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }
  }

  function scheduleTick() {
    clearTimerIds();
    state.intervalId = window.setInterval(tick, TICK_INTERVAL);
    state.timeoutId = window.setTimeout(tick, state.remainingMs + 40);
  }

  function startTimer() {
    if (state.status === 'running') {
      return;
    }
    if (state.status === 'done' || state.remainingMs <= 0) {
      state.totalMs = durationMs(state.mode);
      state.remainingMs = state.totalMs;
    }
    state.status = 'running';
    state.endAt = Date.now() + state.remainingMs;
    hideCompletion();
    resumeAudio();
    scheduleTick();
    render();
  }

  function pauseTimer() {
    if (state.status !== 'running') {
      return;
    }
    var remaining = Math.max(0, state.endAt - Date.now());
    if (remaining <= 0) {
      tick();
      return;
    }
    state.remainingMs = remaining;
    clearTimerIds();
    state.status = 'paused';
    render();
  }

  function resetTimer() {
    clearTimerIds();
    state.status = 'idle';
    state.totalMs = durationMs(state.mode);
    state.remainingMs = state.totalMs;
    state.endAt = 0;
    hideCompletion();
    render();
  }

  function tick() {
    if (state.status !== 'running') {
      return;
    }
    var remaining = state.endAt - Date.now();
    if (remaining <= 0) {
      completeTimer();
      return;
    }
    state.remainingMs = remaining;
    renderClock();
  }

  function completeTimer() {
    if (state.status !== 'running') {
      return;
    }
    clearTimerIds();
    state.remainingMs = 0;
    state.status = 'done';
    state.endAt = 0;

    var finishedMode = state.mode;
    ensureToday();

    if (finishedMode === 'focus') {
      stats.count += 1;
      saveStats();
      renderStats();
      animateCount();
      showCompletion('focus', stats.count % 4 === 0 ? 'long' : 'short');
      launchConfetti();
      celebrate();
    } else {
      showCompletion('break', 'focus');
    }

    if (settings.sound) {
      playChime(finishedMode === 'focus' ? 'focus' : 'break');
    }

    render();
  }

  function handleToggle() {
    if (state.status === 'running') {
      pauseTimer();
    } else {
      startTimer();
    }
  }

  function setMode(mode) {
    if (!MODE_CONFIG[mode]) {
      return;
    }
    clearTimerIds();
    state.mode = mode;
    state.status = 'idle';
    state.totalMs = durationMs(mode);
    state.remainingMs = state.totalMs;
    state.endAt = 0;
    hideCompletion();
    document.body.dataset.mode = mode;
    render();
  }

  function handleCompletionNext() {
    var next = el.completionNext.dataset.nextMode || 'focus';
    hideCompletion();
    setMode(next);
    startTimer();
  }

  /* ---------- 渲染 ---------- */

  function render() {
    var config = MODE_CONFIG[state.mode];
    document.body.dataset.mode = state.mode;

    Array.prototype.forEach.call(document.querySelectorAll('.mode-tab'), function (tab) {
      tab.setAttribute('aria-pressed', String(tab.dataset.mode === state.mode));
    });

    el.modeName.textContent = config.timerName;
    el.statusText.textContent = statusText();
    el.toggleBtn.textContent =
      state.status === 'running' ? '暂停' : state.status === 'paused' ? '继续' : '开始';

    el.timerCard.classList.toggle('is-running', state.status === 'running');
    el.timerCard.classList.toggle('is-paused', state.status === 'paused');
    el.timerCard.classList.toggle('is-done', state.status === 'done');

    updateTabDurations();
    renderSound();
    renderClock();
  }

  function renderClock() {
    var display = formatClock(state.remainingMs);
    var fraction =
      state.totalMs > 0 ? Math.min(1, Math.max(0, state.remainingMs / state.totalMs)) : 0;

    el.timeDisplay.textContent = display;
    el.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
    updateTabTitle(display);
  }

  function updateTabTitle(display) {
    var config = MODE_CONFIG[state.mode];
    if (state.status === 'running') {
      document.title = display + ' · ' + config.name + '中 — 番茄时钟';
    } else if (state.status === 'paused') {
      document.title = display + ' · 已暂停 — 番茄时钟';
    } else if (state.status === 'done') {
      document.title = '完成 · 番茄时钟';
    } else {
      document.title = display + ' · ' + config.name + ' — 番茄时钟';
    }
  }

  function statusText() {
    if (state.status === 'running') {
      if (state.mode === 'focus') {
        return '专注中，保持节奏';
      }
      return state.mode === 'short' ? '短休息中，放松一下' : '长休息中，好好充电';
    }
    if (state.status === 'paused') {
      return '已暂停';
    }
    if (state.status === 'done') {
      return state.completionKind === 'focus' ? '专注完成' : '休息结束';
    }
    return '准备开始';
  }

  function updateTabDurations() {
    MODE_ORDER.forEach(function (mode) {
      var node = document.querySelector('[data-duration="' + mode + '"]');
      if (node) {
        node.textContent = settings[MODE_CONFIG[mode].settingKey] + ' 分';
      }
    });
  }

  function renderSound() {
    el.soundToggle.setAttribute('aria-pressed', String(settings.sound));
    el.soundToggle.setAttribute('aria-label', settings.sound ? '关闭提示音' : '开启提示音');
    el.soundLabel.textContent = settings.sound ? '声音开' : '声音关';
  }

  function renderSettingsInputs() {
    el.focusMinutes.value = String(settings.focusMinutes);
    el.shortMinutes.value = String(settings.shortMinutes);
    el.longMinutes.value = String(settings.longMinutes);
  }

  function renderStats() {
    el.focusCount.textContent = String(stats.count);
    if (stats.count === 0) {
      el.statCaption.textContent = '完成第一个番茄，开始专注吧';
    } else if (stats.count < 4) {
      el.statCaption.textContent = '今天已完成 ' + stats.count + ' 次专注，继续保持';
    } else if (stats.count < 8) {
      el.statCaption.textContent = '今天已完成 ' + stats.count + ' 次专注，节奏不错';
    } else {
      el.statCaption.textContent = '今天已完成 ' + stats.count + ' 次专注，记得劳逸结合';
    }
  }

  function animateCount() {
    el.focusCount.classList.remove('is-bumping');
    // 触发一次重排，让动画可以重复播放。
    void el.focusCount.offsetWidth;
    el.focusCount.classList.add('is-bumping');
    window.setTimeout(function () {
      el.focusCount.classList.remove('is-bumping');
    }, 600);
  }

  function showCompletion(kind, nextMode) {
    state.completionKind = kind;
    var nextLabel =
      nextMode === 'long' ? '开始长休息' : nextMode === 'short' ? '开始短休息' : '开始专注';
    el.completionNext.textContent = nextLabel;
    el.completionNext.dataset.nextMode = nextMode;

    if (kind === 'focus') {
      var count = stats.count;
      if (nextMode === 'long') {
        el.completionTitle.textContent = '完成 ' + count + ' 个番茄，来个长休息吧！';
        el.completionText.textContent =
          '今天已完成 ' + count + ' 次专注。建议休息 ' + settings.longMinutes + ' 分钟，让注意力好好恢复。';
      } else {
        el.completionTitle.textContent = '专注完成！';
        el.completionText.textContent =
          '今天已完成 ' + count + ' 次专注。起身活动一下，喝口水吧。';
      }
    } else {
      el.completionTitle.textContent = '休息结束！';
      el.completionText.textContent = '准备好开始下一轮专注了吗？';
    }

    el.completion.hidden = false;
    updateCompletionAudioNote();

    if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
      el.completion.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'nearest'
      });
    }
  }

  function hideCompletion() {
    el.completion.hidden = true;
    el.completionNote.hidden = true;
    state.completionKind = null;
    el.completionNext.dataset.nextMode = '';
  }

  function celebrate() {
    if (prefersReducedMotion()) {
      return;
    }
    el.timerCard.classList.remove('is-celebrating');
    void el.timerCard.offsetWidth;
    el.timerCard.classList.add('is-celebrating');
    if (state.celebrateTimeout) {
      window.clearTimeout(state.celebrateTimeout);
    }
    state.celebrateTimeout = window.setTimeout(function () {
      el.timerCard.classList.remove('is-celebrating');
    }, 1400);
  }

  /* ---------- 彩纸动画 ---------- */

  function initConfetti() {
    confetti.canvas = document.getElementById('confetti');
    if (!confetti.canvas || !confetti.canvas.getContext) {
      return;
    }
    confetti.ctx = confetti.canvas.getContext('2d');
    resizeConfettiCanvas();
  }

  function resizeConfettiCanvas() {
    if (!confetti.canvas || !confetti.ctx) {
      return;
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    confetti.canvas.width = Math.floor(window.innerWidth * dpr);
    confetti.canvas.height = Math.floor(window.innerHeight * dpr);
    confetti.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function launchConfetti() {
    if (!confetti.ctx || prefersReducedMotion()) {
      return;
    }
    resizeConfettiCanvas();

    var styles = window.getComputedStyle(document.body);
    var accent = styles.getPropertyValue('--accent').trim() || '#ff9d5c';
    var accentSoft = styles.getPropertyValue('--accent-soft').trim() || '#ffcf87';
    var colors = [accent, accentSoft, '#ffffff', '#ffd166', '#7dd3fc'];
    var originX = window.innerWidth / 2;
    var originY = Math.min(window.innerHeight * 0.44, 420);

    for (var i = 0; i < 90; i += 1) {
      var angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
      var speed = 3.5 + Math.random() * 7.5;
      confetti.particles.push({
        x: originX + (Math.random() - 0.5) * 90,
        y: originY + (Math.random() - 0.5) * 30,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        life: 0,
        ttl: 1500 + Math.random() * 1000
      });
    }

    if (!confetti.running) {
      confetti.running = true;
      confetti.lastTime = performance.now();
      confetti.rafId = window.requestAnimationFrame(confettiFrame);
    }
  }

  function confettiFrame(now) {
    if (!confetti.ctx) {
      confetti.running = false;
      return;
    }
    var dt = Math.min(Math.max((now - confetti.lastTime) / 16.667, 0.25), 2.5);
    confetti.lastTime = now;
    var ctx = confetti.ctx;
    var width = window.innerWidth;
    var height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);

    for (var i = confetti.particles.length - 1; i >= 0; i -= 1) {
      var particle = confetti.particles[i];
      particle.life += dt * 16.667;
      particle.vy += 0.28 * dt;
      particle.vx *= 0.996;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.rotation += particle.spin * dt;

      var fadeStart = particle.ttl * 0.68;
      var alpha =
        particle.life > fadeStart
          ? Math.max(0, 1 - (particle.life - fadeStart) / (particle.ttl - fadeStart))
          : 1;

      if (particle.life >= particle.ttl || particle.y > height + 40) {
        confetti.particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      ctx.fillStyle = particle.color;
      ctx.fillRect(-particle.size / 2, -particle.size * 0.32, particle.size, particle.size * 0.64);
      ctx.restore();
    }

    if (confetti.particles.length > 0) {
      confetti.rafId = window.requestAnimationFrame(confettiFrame);
    } else {
      confetti.running = false;
      ctx.clearRect(0, 0, width, height);
    }
  }

  /* ---------- 设置交互 ---------- */

  function bindDurationInput(input, mode) {
    input.addEventListener('change', function () {
      var key = MODE_CONFIG[mode].settingKey;
      var value = Number(input.value);
      if (!isFinite(value)) {
        input.value = String(settings[key]);
        return;
      }
      var nextValue = clampMinutes(value);
      settings[key] = nextValue;
      input.value = String(nextValue);
      saveSettings();
      updateTabDurations();
      if (state.mode === mode) {
        setMode(mode);
      }
    });
  }

  function toggleSound() {
    settings.sound = !settings.sound;
    saveSettings();
    renderSound();
    if (settings.sound) {
      playChime('preview');
    } else {
      updateCompletionAudioNote();
    }
  }

  function previewSound() {
    playChime('preview');
  }

  function restoreDefaults() {
    settings.focusMinutes = DEFAULT_SETTINGS.focusMinutes;
    settings.shortMinutes = DEFAULT_SETTINGS.shortMinutes;
    settings.longMinutes = DEFAULT_SETTINGS.longMinutes;
    saveSettings();
    renderSettingsInputs();
    updateTabDurations();
    setMode(state.mode);
  }

  /* ---------- 初始化与事件 ---------- */

  function cacheElements() {
    el.timerCard = document.getElementById('timerCard');
    el.timeDisplay = document.getElementById('timeDisplay');
    el.statusText = document.getElementById('statusText');
    el.modeName = document.getElementById('modeName');
    el.toggleBtn = document.getElementById('toggleBtn');
    el.resetBtn = document.getElementById('resetBtn');
    el.ringProgress = document.getElementById('ringProgress');
    el.soundToggle = document.getElementById('soundToggle');
    el.soundLabel = el.soundToggle.querySelector('.sound-label');
    el.focusCount = document.getElementById('focusCount');
    el.statCaption = document.getElementById('statCaption');
    el.storageWarning = document.getElementById('storageWarning');
    el.completion = document.getElementById('completion');
    el.completionTitle = document.getElementById('completionTitle');
    el.completionText = document.getElementById('completionText');
    el.completionNote = document.getElementById('completionNote');
    el.completionNext = document.getElementById('completionNext');
    el.completionDismiss = document.getElementById('completionDismiss');
    el.focusMinutes = document.getElementById('focusMinutes');
    el.shortMinutes = document.getElementById('shortMinutes');
    el.longMinutes = document.getElementById('longMinutes');
    el.soundNote = document.getElementById('soundNote');
    el.testSoundBtn = document.getElementById('testSoundBtn');
    el.restoreDefaults = document.getElementById('restoreDefaults');
  }

  function bindEvents() {
    el.toggleBtn.addEventListener('click', handleToggle);
    el.resetBtn.addEventListener('click', resetTimer);
    el.completionNext.addEventListener('click', handleCompletionNext);
    el.completionDismiss.addEventListener('click', hideCompletion);
    el.soundToggle.addEventListener('click', toggleSound);
    el.testSoundBtn.addEventListener('click', previewSound);
    el.restoreDefaults.addEventListener('click', restoreDefaults);

    Array.prototype.forEach.call(document.querySelectorAll('.mode-tab'), function (tab) {
      tab.addEventListener('click', function () {
        if (tab.dataset.mode !== state.mode) {
          setMode(tab.dataset.mode);
        }
      });
    });

    bindDurationInput(el.focusMinutes, 'focus');
    bindDurationInput(el.shortMinutes, 'short');
    bindDurationInput(el.longMinutes, 'long');

    document.addEventListener('keydown', function (event) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      var target = event.target;
      if (
        target &&
        target.closest &&
        target.closest('input, textarea, select, button, [contenteditable="true"]')
      ) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        handleToggle();
      } else if (event.key === 'r' || event.key === 'R') {
        resetTimer();
      } else if (event.key === '1' || event.key === '2' || event.key === '3') {
        var mode = MODE_ORDER[Number(event.key) - 1];
        if (mode && mode !== state.mode) {
          setMode(mode);
        }
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        ensureToday();
        if (state.status === 'running') {
          tick();
        } else {
          renderClock();
        }
      }
    });

    window.addEventListener('focus', function () {
      if (state.status === 'running') {
        tick();
      }
    });

    window.addEventListener('resize', resizeConfettiCanvas);
  }

  function init() {
    cacheElements();
    storageAvailable = detectStorage();
    settings = loadSettings();
    stats = loadStats();
    if (!storageAvailable) {
      el.storageWarning.hidden = false;
    }
    // 把规范化后的默认值写回，保证首次打开就有可用的本地设置。
    saveSettings();
    saveStats();

    el.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    initConfetti();
    bindEvents();

    setMode('focus');
    renderSettingsInputs();
    renderStats();
    renderSound();
    updateCompletionAudioNote();
  }

  init();
})();
