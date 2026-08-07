(() => {
  const DIFFICULTIES = {
    easy: { rivalSpeed: 14, label: 'Easy' },
    normal: { rivalSpeed: 20, label: 'Normal' },
    hard: { rivalSpeed: 27, label: 'Hard' },
  };

  const BASE_CLICK_GAIN = 3.2;
  const COMBO_WINDOW_MS = 450;
  const COMBO_STEP = 0.15;
  const COMBO_MAX = 3.0;
  const COMBO_DECAY_PER_SEC = 1.0;

  const CATCH_SLOT_COUNT = 5;
  const MEAT_LIFESPAN_MS = 1400;
  const MEAT_FADE_MS = 300;
  const MEAT_SPAWN_MIN_MS = 700;
  const MEAT_SPAWN_MAX_MS = 1500;
  const MEAT_BONUS_GAIN = 6;
  const MEAT_COMBO_BOOST = 0.4;
  const MAX_ACTIVE_MEAT = 2;

  const screens = {
    start: document.getElementById('screen-start'),
    game: document.getElementById('screen-game'),
    result: document.getElementById('screen-result'),
  };

  const diffButtons = document.querySelectorAll('.diff-btn');
  const startBtn = document.getElementById('start-btn');
  const slurpBtn = document.getElementById('slurp-btn');
  const retryBtn = document.getElementById('retry-btn');
  const bestTimeDisplay = document.getElementById('best-time-display');
  const timerDisplay = document.getElementById('timer-display');
  const comboDisplay = document.getElementById('combo-display');
  const playerFill = document.getElementById('player-fill');
  const rivalFill = document.getElementById('rival-fill');
  const playerNoodles = document.getElementById('player-noodles');
  const rivalNoodles = document.getElementById('rival-noodles');
  const playerChopsticks = document.getElementById('player-chopsticks');
  const floatingLayer = document.getElementById('floating-layer');
  const resultTitle = document.getElementById('result-title');
  const resultTime = document.getElementById('result-time');
  const resultNewBest = document.getElementById('result-new-best');
  const catchTrack = document.getElementById('catch-track');
  const catchPointer = document.getElementById('catch-pointer');
  const catchLeftBtn = document.getElementById('catch-left');
  const catchRightBtn = document.getElementById('catch-right');
  const meatCaughtDisplay = document.getElementById('meat-caught-display');

  let selectedDifficulty = 'normal';
  let state = null;

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle('active', key === name);
    });
  }

  function bestTimeKey(diff) {
    return `ramenRace.bestTime.${diff}`;
  }

  function loadBestTime(diff) {
    const raw = localStorage.getItem(bestTimeKey(diff));
    return raw ? parseFloat(raw) : null;
  }

  function saveBestTime(diff, seconds) {
    localStorage.setItem(bestTimeKey(diff), seconds.toFixed(2));
  }

  function refreshBestTimeDisplay() {
    const best = loadBestTime(selectedDifficulty);
    bestTimeDisplay.textContent = best
      ? `Best time (${DIFFICULTIES[selectedDifficulty].label}): ${best.toFixed(2)}s`
      : `No best time yet for ${DIFFICULTIES[selectedDifficulty].label}.`;
  }

  diffButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      diffButtons.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedDifficulty = btn.dataset.diff;
      refreshBestTimeDisplay();
    });
  });

  function slotToPercent(slot) {
    return (slot / (CATCH_SLOT_COUNT - 1)) * 100;
  }

  function resetState() {
    state = {
      playerProgress: 0,
      rivalProgress: 0,
      combo: 1.0,
      lastClickTime: null,
      startTime: performance.now(),
      lastFrameTime: performance.now(),
      finished: false,
      rafId: null,
      chopstickSlot: Math.floor(CATCH_SLOT_COUNT / 2),
      meatChunks: [],
      meatSpawnTimer: null,
      meatCaught: 0,
    };
  }

  function startGame() {
    resetState();
    playerFill.style.width = '0%';
    rivalFill.style.width = '0%';
    playerNoodles.style.height = '100%';
    rivalNoodles.style.height = '100%';
    comboDisplay.textContent = 'x1.0';
    timerDisplay.textContent = '0.0s';
    meatCaughtDisplay.textContent = '0';
    catchTrack.querySelectorAll('.meat-chunk').forEach(el => el.remove());
    catchPointer.style.left = `${slotToPercent(state.chopstickSlot)}%`;
    showScreen('game');
    state.rafId = requestAnimationFrame(loop);
    scheduleMeatSpawn();
  }

  function loop(now) {
    if (!state || state.finished) return;
    const dt = (now - state.lastFrameTime) / 1000;
    state.lastFrameTime = now;

    const rivalSpeed = DIFFICULTIES[selectedDifficulty].rivalSpeed;
    state.rivalProgress = Math.min(100, state.rivalProgress + rivalSpeed * dt);

    if (state.combo > 1.0) {
      state.combo = Math.max(1.0, state.combo - COMBO_DECAY_PER_SEC * dt);
      comboDisplay.textContent = `x${state.combo.toFixed(1)}`;
    }

    rivalFill.style.width = `${state.rivalProgress}%`;
    rivalNoodles.style.height = `${100 - state.rivalProgress}%`;

    const elapsed = (now - state.startTime) / 1000;
    timerDisplay.textContent = `${elapsed.toFixed(1)}s`;

    if (state.rivalProgress >= 100) {
      endGame(false, elapsed);
      return;
    }

    state.rafId = requestAnimationFrame(loop);
  }

  function spawnFloatText(gain, anchorEl, suffix = '') {
    const rect = anchorEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = `+${gain.toFixed(1)}${suffix}`;
    el.style.left = `${rect.left + rect.width / 2 + (Math.random() * 40 - 20)}px`;
    el.style.top = `${rect.top}px`;
    floatingLayer.appendChild(el);
    setTimeout(() => el.remove(), 700);
  }

  function moveChopstick(delta) {
    if (!state || state.finished) return;
    const next = Math.min(CATCH_SLOT_COUNT - 1, Math.max(0, state.chopstickSlot + delta));
    if (next === state.chopstickSlot) return;
    state.chopstickSlot = next;
    catchPointer.style.left = `${slotToPercent(next)}%`;
    const chunk = state.meatChunks.find(c => c.slot === next);
    if (chunk) catchMeatChunk(chunk);
  }

  function scheduleMeatSpawn() {
    if (!state || state.finished) return;
    const delay = MEAT_SPAWN_MIN_MS + Math.random() * (MEAT_SPAWN_MAX_MS - MEAT_SPAWN_MIN_MS);
    state.meatSpawnTimer = setTimeout(spawnMeatChunk, delay);
  }

  function spawnMeatChunk() {
    if (!state || state.finished) return;
    if (state.meatChunks.length < MAX_ACTIVE_MEAT) {
      const occupied = new Set(state.meatChunks.map(c => c.slot));
      const available = [];
      for (let i = 0; i < CATCH_SLOT_COUNT; i++) {
        if (!occupied.has(i)) available.push(i);
      }
      if (available.length > 0) {
        const slot = available[Math.floor(Math.random() * available.length)];
        const el = document.createElement('div');
        el.className = 'meat-chunk';
        el.textContent = '🍖';
        el.style.left = `${slotToPercent(slot)}%`;
        catchTrack.appendChild(el);

        const chunk = { slot, el, fadeTimer: null, expireTimer: null };
        chunk.fadeTimer = setTimeout(() => {
          el.classList.add('fading');
        }, MEAT_LIFESPAN_MS - MEAT_FADE_MS);
        chunk.expireTimer = setTimeout(() => {
          removeMeatChunk(chunk);
        }, MEAT_LIFESPAN_MS);
        state.meatChunks.push(chunk);

        if (slot === state.chopstickSlot) {
          catchMeatChunk(chunk);
        }
      }
    }
    scheduleMeatSpawn();
  }

  function removeMeatChunk(chunk) {
    clearTimeout(chunk.fadeTimer);
    clearTimeout(chunk.expireTimer);
    chunk.el.remove();
    if (state) state.meatChunks = state.meatChunks.filter(c => c !== chunk);
  }

  function catchMeatChunk(chunk) {
    removeMeatChunk(chunk);
    state.meatCaught += 1;
    meatCaughtDisplay.textContent = String(state.meatCaught);
    state.combo = Math.min(COMBO_MAX, state.combo + MEAT_COMBO_BOOST);
    comboDisplay.textContent = `x${state.combo.toFixed(1)}`;
    state.playerProgress = Math.min(100, state.playerProgress + MEAT_BONUS_GAIN);
    playerFill.style.width = `${state.playerProgress}%`;
    playerNoodles.style.height = `${100 - state.playerProgress}%`;
    spawnFloatText(MEAT_BONUS_GAIN, catchTrack, ' 🍖');

    if (state.playerProgress >= 100) {
      const elapsed = (performance.now() - state.startTime) / 1000;
      endGame(true, elapsed);
    }
  }

  function handleSlurp() {
    if (!state || state.finished) return;
    const now = performance.now();

    if (state.lastClickTime !== null && now - state.lastClickTime < COMBO_WINDOW_MS) {
      state.combo = Math.min(COMBO_MAX, state.combo + COMBO_STEP);
    }
    state.lastClickTime = now;
    comboDisplay.textContent = `x${state.combo.toFixed(1)}`;

    const gain = BASE_CLICK_GAIN * state.combo;
    state.playerProgress = Math.min(100, state.playerProgress + gain);
    playerFill.style.width = `${state.playerProgress}%`;
    playerNoodles.style.height = `${100 - state.playerProgress}%`;

    playerChopsticks.classList.remove('slurping');
    void playerChopsticks.offsetWidth;
    playerChopsticks.classList.add('slurping');

    spawnFloatText(gain, slurpBtn);

    if (state.playerProgress >= 100) {
      const elapsed = (now - state.startTime) / 1000;
      endGame(true, elapsed);
    }
  }

  function endGame(playerWon, elapsedSeconds) {
    if (!state || state.finished) return;
    state.finished = true;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.meatSpawnTimer) clearTimeout(state.meatSpawnTimer);
    state.meatChunks.forEach(chunk => {
      clearTimeout(chunk.fadeTimer);
      clearTimeout(chunk.expireTimer);
    });

    resultNewBest.textContent = '';

    if (playerWon) {
      resultTitle.textContent = 'You win! 🏆';
      resultTime.textContent = `Finished in ${elapsedSeconds.toFixed(2)}s`;
      const best = loadBestTime(selectedDifficulty);
      if (!best || elapsedSeconds < best) {
        saveBestTime(selectedDifficulty, elapsedSeconds);
        resultNewBest.textContent = '🎉 New best time!';
      }
    } else {
      resultTitle.textContent = 'Rival wins! 😅';
      resultTime.textContent = `They finished in ${elapsedSeconds.toFixed(2)}s. Try again!`;
    }

    showScreen('result');
    refreshBestTimeDisplay();
  }

  slurpBtn.addEventListener('click', handleSlurp);
  slurpBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    handleSlurp();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (!screens.game.classList.contains('active')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      handleSlurp();
    } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      e.preventDefault();
      moveChopstick(-1);
    } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      e.preventDefault();
      moveChopstick(1);
    }
  });

  catchLeftBtn.addEventListener('click', () => moveChopstick(-1));
  catchLeftBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    moveChopstick(-1);
  }, { passive: false });

  catchRightBtn.addEventListener('click', () => moveChopstick(1));
  catchRightBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    moveChopstick(1);
  }, { passive: false });

  startBtn.addEventListener('click', startGame);
  retryBtn.addEventListener('click', () => showScreen('start'));

  refreshBestTimeDisplay();
})();
