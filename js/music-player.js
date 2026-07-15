/* ============================================================
   MUSIC PLAYER — a single soundtrack that starts on the visitor's
   very first interaction anywhere on the page, per modern browser
   autoplay policy. No autoplay "hacks" are used here — there isn't
   a reliable one. Every major browser (Chrome, Safari, Firefox,
   Edge, mobile included) requires a genuine user gesture before it
   will allow audio-with-sound to start, full stop. So instead of
   fighting that, this file works *with* it:

     1. On load, it arms a single, page-wide listener for the very
        first click / tap / keypress, anywhere — not just on the
        player itself.
     2. The instant that gesture fires, audio.play() is called
        synchronously inside the same event handler (this matters:
        calling it later, e.g. after an await, loses the "trusted
        gesture" the browser is checking for). That's the earliest
        possible moment a soundtrack is legally allowed to start,
        which is exactly what "as early as possible, no hacks" means
        in practice.
     3. Volume fades in from 0 over ~1s once playback actually begins,
        instead of starting at full volume.

   State (playback position + whether the visitor wants music on)
   is remembered in localStorage, so:
     - A refresh resumes from the same position, automatically, on
       the next first interaction — no separate re-enable step.
     - An explicit pause is respected: refreshing won't force music
       back on if the visitor turned it off themselves.

   This is a single-page, anchor-scrolled site (Lenis smooth scroll,
   no hard navigation between sections), so the <audio> element is
   never torn down or re-created while moving between sections —
   it simply keeps playing, uninterrupted, by construction.
============================================================ */
'use strict';

(function musicPlayer(){
  const audio     = document.getElementById('audioEl');
  const wrap      = document.getElementById('player');
  const playBtn   = document.getElementById('trackPlayBtn');
  const scrub     = document.getElementById('trackScrub');
  const scrubFill = document.getElementById('trackScrubFill');
  const curEl     = document.getElementById('trackCurrent');
  const durEl     = document.getElementById('trackDuration');
  if (!audio) return;

  const cfg = (typeof CONFIG !== 'undefined' && CONFIG.audio) ? CONFIG.audio : {};
  const STORE_KEY  = cfg.storeKey       || 'nabila-garden-audio-state';
  const FADE_MS    = cfg.fadeMs         || 1000;
  const TARGET_VOL = cfg.targetVolume   != null ? cfg.targetVolume : 0.85;
  const SAVE_MS     = cfg.saveIntervalMs || 4000;
  const AUTO_START  = cfg.autoStart !== false && !document.getElementById('pinGate');

  let fadeRAF   = null;
  let scrubbing = false;

  /* ---------------- state persistence ----------------
     `enabled` tracks visitor *intent*, not just current playback:
     true unless they explicitly hit pause. That single flag is what
     makes "resume after refresh" and "start on first visit" the
     same code path, and what stops a refresh from overriding an
     explicit pause.
  ----------------------------------------------------- */
  function readState(){
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; } // private browsing / storage disabled
  }
  function writeState(patch){
    try {
      const current = readState() || {};
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign(current, patch)));
    } catch (e) { /* ignore — non-fatal */ }
  }
  const saved = readState();

  const fmt = s => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  /* ---------------- fade helper ---------------- */
  function fadeTo(target, ms, onDone){
    cancelAnimationFrame(fadeRAF);
    if (ms <= 0){ audio.volume = Math.min(1, Math.max(0, target)); if (onDone) onDone(); return; }
    const start = audio.volume, delta = target - start, t0 = performance.now();
    (function step(now){
      const p = Math.min(1, Math.max(0, (now - t0) / ms));
      const eased = start + delta * (p * (2 - p)); // ease-out
      audio.volume = Math.min(1, Math.max(0, eased)); // volume throws outside [0,1] — floating-point drift can land just past either edge
      if (p < 1){ fadeRAF = requestAnimationFrame(step); }
      else if (onDone){ onDone(); }
    })(t0);
  }

  /* ---------------- transport ---------------- */
  function play(onRejected){
    audio.volume = 0;
    const attempt = audio.play();
    if (attempt && attempt.then){
      attempt.then(() => {
        wrap && wrap.classList.add('playing');
        fadeTo(TARGET_VOL, FADE_MS);
        writeState({ enabled: true });
      }).catch(() => {
        // Not accepted as a trusted gesture by this browser (or a
        // stray programmatic call) — leave the UI at rest rather than
        // showing "playing" for audio that isn't. `onRejected`, when
        // given, is how the auto-start listener re-arms itself for
        // the next interaction instead of giving up for the session.
        wrap && wrap.classList.remove('playing');
        if (typeof onRejected === 'function') onRejected();
      });
    } else {
      // Very old browsers without a Promise-returning play()
      wrap && wrap.classList.add('playing');
      fadeTo(TARGET_VOL, FADE_MS);
      writeState({ enabled: true });
    }
  }
  function pause(explicit){
    fadeTo(0, FADE_MS, () => audio.pause());
    wrap && wrap.classList.remove('playing');
    if (explicit) writeState({ enabled: false, time: audio.currentTime || 0 });
  }

  playBtn && playBtn.addEventListener('click', () => {
    if (audio.paused) play(); else pause(true);
  });

  /* ---------------- direct start, for js/pin-intro.js ----------------
     When a PIN gate is present (#pinGate in the markup), the global
     first-interaction auto-start below is disabled on purpose — the
     visitor's first tap lands on the PIN pad, well before the code is
     actually accepted, and starting music on that first digit would
     jump ahead of the reveal. Instead js/pin-intro.js calls this
     directly, synchronously, the moment the correct PIN is confirmed —
     which is still happening inside that same trusted click/keydown/
     input handler, so every browser's autoplay policy still counts it.

     If that particular call is still rejected (a stricter engine that
     doesn't treat this exact event as a trusted gesture), this arms a
     one-shot fallback so the very next tap, key press, or scroll-
     initiating touch anywhere on the page retries it — instead of the
     visitor being left with no music for the rest of the session. */
  let musicRetryArmed = false;
  function armMusicRetry(){
    if (musicRetryArmed || (saved && saved.enabled === false)) return;
    musicRetryArmed = true;
    const RETRY_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
    function onRetryGesture(e){
      const targetIsPlayButton = playBtn && e.target && e.target.closest && e.target.closest('#trackPlayBtn');
      if (targetIsPlayButton || !audio.paused) return;
      musicRetryArmed = false;
      RETRY_EVENTS.forEach(ev => document.removeEventListener(ev, onRetryGesture, true));
      play(armMusicRetry); // still rejected? re-arm again for the next gesture
    }
    RETRY_EVENTS.forEach(ev => document.addEventListener(ev, onRetryGesture, { capture:true, passive:true }));
  }
  window.__startBackgroundMusic = function(){
    if (audio.paused) play(armMusicRetry);
  };

  /* ---------------- restore saved position ---------------- */
  audio.addEventListener('loadedmetadata', () => {
    durEl && (durEl.textContent = fmt(audio.duration));
    if (saved && saved.time > 0 && saved.time < audio.duration - 1){
      audio.currentTime = saved.time;
    }
  });
  audio.addEventListener('timeupdate', () => {
    if (scrubbing) return;
    curEl && (curEl.textContent = fmt(audio.currentTime));
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    scrubFill && (scrubFill.style.width = pct + '%');
    scrub && scrub.setAttribute('aria-valuenow', Math.round(pct));
  });
  audio.addEventListener('ended', () => {
    wrap && wrap.classList.remove('playing');
    writeState({ time: 0, enabled: false });
  });
  window.addEventListener('beforeunload', () => {
    writeState({ time: audio.currentTime || 0, enabled: !audio.paused });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) writeState({ time: audio.currentTime || 0, enabled: !audio.paused });
  });
  setInterval(() => { if (!audio.paused) writeState({ time: audio.currentTime || 0 }); }, SAVE_MS);

  /* ---------------- scrub bar ---------------- */
  function seekFromEvent(e){
    if (!scrub) return;
    const r = scrub.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = clamp((clientX - r.left) / r.width, 0, 1);
    if (audio.duration){ audio.currentTime = pct * audio.duration; }
    scrubFill && (scrubFill.style.width = (pct * 100) + '%');
  }
  if (scrub){
    scrub.addEventListener('pointerdown', e => { scrubbing = true; seekFromEvent(e); });
    window.addEventListener('pointermove', e => { if (scrubbing) seekFromEvent(e); });
    window.addEventListener('pointerup', () => { scrubbing = false; });
    scrub.addEventListener('keydown', e => {
      if (!audio.duration) return;
      if (e.key === 'ArrowRight'){ audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); }
      if (e.key === 'ArrowLeft'){  audio.currentTime = Math.max(0, audio.currentTime - 5); }
    });
  }

  /* ============================================================
     FIRST-INTERACTION AUTOPLAY UNLOCK

     Arm once, on page load. Disarm on the very first qualifying
     gesture, anywhere in the document, in the capture phase (so it
     always fires first, even if the gesture lands on an element
     that stops propagation). `passive: true` because nothing here
     needs to preventDefault — this listener only *observes* the
     gesture, it never blocks it.

     Special case: if that very first gesture is a click directly on
     the player's own Play button, we deliberately skip calling
     play() from here and let the button's existing click handler
     do it — calling play() twice in the same tick (once from this
     global listener, once from the button handler reading the now-
     already-toggled `audio.paused`) would start and instantly pause
     it again, since `.paused` flips to false synchronously the
     moment play() is invoked, before the click handler even runs.
  ============================================================ */
  if (AUTO_START && (!saved || saved.enabled !== false)){
    // Listed explicitly (rather than relying on click/pointerdown alone
    // to imply the rest) so every one of these counts as the unlocking
    // gesture, on every engine: pointerdown/touchstart fire earliest on
    // touch, mousedown/click cover desktop and any browser that doesn't
    // synthesize pointer events, keydown covers keyboard-only visitors.
    const GESTURE_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'touchend', 'click', 'keydown'];
    let armed = true;

    function disarm(){
      armed = false;
      GESTURE_EVENTS.forEach(ev => document.removeEventListener(ev, onFirstInteraction, true));
    }
    function rearm(){
      // A rejected play() doesn't mean the visitor never gets music —
      // it means *that particular* event wasn't accepted as a trusted
      // gesture by this browser. Listen again for the next one instead
      // of giving up for the rest of the session.
      armed = true;
      GESTURE_EVENTS.forEach(ev => document.addEventListener(ev, onFirstInteraction, { capture: true, passive: true }));
    }

    function onFirstInteraction(e){
      if (!armed) return;
      disarm();

      const targetIsPlayButton = playBtn && e.target && e.target.closest && e.target.closest('#trackPlayBtn');
      if (targetIsPlayButton || !audio.paused) return;

      play(rearm);
    }

    GESTURE_EVENTS.forEach(ev => document.addEventListener(ev, onFirstInteraction, { capture: true, passive: true }));
  }
})();
