/**
 * The veil Write Now runs behind: the screen fades to black, the steps
 * (full screen, Midnight, desk, new document, Zen) happen out of sight,
 * and it fades back once the document is ready to type into — so the
 * sequence reads as one move rather than a macro flicking through the
 * app. Pointer input is swallowed while it is up; it sits above Zen and
 * every modal band, since Zen is the last thing to open underneath it.
 */

const FADE_OUT_MS = 260;
const FADE_IN_MS = 420;

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function waitTransition(el, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("transitionend", finish);
      resolve();
    };
    el.addEventListener("transitionend", finish);
    // transitionend never fires when the transition is skipped (reduced
    // motion, a hidden window) — the timer is the floor.
    setTimeout(finish, ms + 60);
  });
}

/** Fade the screen out. Resolves with the veil once it is opaque. */
export async function raiseVeil() {
  document.querySelectorAll(".write-now-veil").forEach((el) => el.remove());
  const veil = document.createElement("div");
  veil.className = "write-now-veil";
  const ms = reducedMotion() ? 0 : FADE_OUT_MS;
  veil.style.transitionDuration = `${ms}ms`;
  document.body.appendChild(veil);
  // Commit the transparent frame before turning it opaque, or the
  // browser coalesces the two and the fade never plays.
  void veil.offsetWidth;
  veil.classList.add("opaque");
  await waitTransition(veil, ms);
  return veil;
}

/** Fade back in and take the veil away. */
export async function lowerVeil(veil) {
  if (!veil?.isConnected) return;
  const ms = reducedMotion() ? 0 : FADE_IN_MS;
  veil.style.transitionDuration = `${ms}ms`;
  veil.classList.remove("opaque");
  await waitTransition(veil, ms);
  veil.remove();
}

/** Wait for the window to stop changing size — the native full-screen
 *  animation on macOS resizes the webview for a good half second after
 *  the call returns. Resolves after `quietMs` without a resize, or at
 *  `maxMs` regardless. */
export function windowSettled({ quietMs = 180, maxMs = 1200 } = {}) {
  return new Promise((resolve) => {
    let quiet = null;
    const finish = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      window.removeEventListener("resize", onResize);
      resolve();
    };
    const onResize = () => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs); };
    const cap = setTimeout(finish, maxMs);
    window.addEventListener("resize", onResize);
    quiet = setTimeout(finish, quietMs);
  });
}
