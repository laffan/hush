/**
 * Finish chimes — a tone as a break ends and another as the session does,
 * for a timer started with "Play finish chimes" ticked.
 *
 * The sounds are plain files in `src/assets/chimes/`; replace them in
 * place to change the tones. Only the main window plays them: every
 * window watches the one timer, and a chime per window would ring as a
 * chord.
 */
import { getCurrentWindowLabel } from "../multi-window.js";

const SOUNDS = {
  break: new URL("../assets/chimes/break-chime.mp3", import.meta.url).href,
  session: new URL("../assets/chimes/session-chime.mp3", import.meta.url).href,
};

let isMainWindow = null;
getCurrentWindowLabel()
  .then((label) => { isMainWindow = label === "main"; })
  .catch(() => { isMainWindow = true; });

/** @param {"break" | "session"} kind */
export function playChime(kind) {
  if (isMainWindow === false) return;
  const src = SOUNDS[kind];
  if (!src) return;
  try {
    const audio = new Audio(src);
    // A refused play (autoplay policy, a missing file) is a missed
    // chime, never an error the timer should surface.
    audio.play().catch(() => {});
  } catch (_) { /* no audio support */ }
}
