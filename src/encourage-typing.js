/**
 * Encourage Typing — Ratchet Mode feature.
 * When enabled, text added during a ratchet session fades out if the user
 * stops pressing keys. If it fades fully (~10s), the new text is deleted.
 */

let encourageState = null;

export function initEncourageTyping(view, state, bypassRatchet) {
  clearEncourageTyping();
  if (!state.settings.ratchetEncourageTyping) return;
  encourageState = {
    baseLength: view.state.doc.length,
    fadeTimer: null,
    fadeStart: null,
    animFrame: null,
    bypassRatchet,
  };
  getOrCreateOverlay();
}

export function clearEncourageTyping() {
  if (!encourageState) return;
  if (encourageState.fadeTimer) clearTimeout(encourageState.fadeTimer);
  if (encourageState.animFrame) cancelAnimationFrame(encourageState.animFrame);
  encourageState = null;
  const overlay = document.querySelector(".encourage-fade-overlay");
  if (overlay) overlay.style.opacity = "0";
}

export function onEncourageKeystroke(view, state) {
  if (!encourageState || !state.settings.ratchetEncourageTyping) return;
  const overlay = getOrCreateOverlay();
  overlay.style.opacity = "0";
  encourageState.fadeStart = null;
  if (encourageState.fadeTimer) clearTimeout(encourageState.fadeTimer);
  if (encourageState.animFrame) cancelAnimationFrame(encourageState.animFrame);

  encourageState.fadeTimer = setTimeout(() => {
    startFade(view);
  }, 2000);
}

function getOrCreateOverlay() {
  let el = document.querySelector(".encourage-fade-overlay");
  if (!el) {
    el = document.createElement("div");
    el.className = "encourage-fade-overlay";
    document.body.appendChild(el);
  }
  return el;
}

function startFade(view) {
  if (!encourageState) return;
  const FADE_DURATION = 10000;
  encourageState.fadeStart = Date.now();
  const overlay = getOrCreateOverlay();

  function tick() {
    if (!encourageState || !encourageState.fadeStart) return;
    const elapsed = Date.now() - encourageState.fadeStart;
    const progress = Math.min(1, elapsed / FADE_DURATION);
    overlay.style.opacity = String(progress * 0.85);

    if (progress >= 1) {
      const currentLen = view.state.doc.length;
      const baseLen = encourageState.baseLength;
      if (currentLen > baseLen) {
        view.dispatch({
          changes: { from: baseLen, to: currentLen },
          annotations: encourageState.bypassRatchet.of(true),
        });
      }
      overlay.style.opacity = "0";
      encourageState.fadeStart = null;
      return;
    }
    encourageState.animFrame = requestAnimationFrame(tick);
  }
  tick();
}
