/**
 * The question asked before a card over `CARD_CONFIRM_WORDS` words is
 * made — by typing or pasting its fences in a Doc (card-doc-plugin.js)
 * or by sending one from Courier.
 */
import { cardWordCount, CARD_CONFIRM_WORDS, CARD_MAX_WORDS } from "./card-model.ts";

/**
 * Ask before making a card over `CARD_CONFIRM_WORDS` words. Resolves
 * true to go ahead. `above` raises the prompt over a sheet that sits
 * above the modal band (Courier).
 */
export async function confirmLongCard(body, { above = false } = {}) {
  const words = cardWordCount(body);
  if (words <= CARD_CONFIRM_WORDS) return true;
  const { showConfirmModal } = await import("../sidebar/files-panel-shared.js");
  return new Promise((resolve) => {
    showConfirmModal({
      title: `Make a card of ${words} words?`,
      message: words > CARD_MAX_WORDS
        ? `Cards hold up to ${CARD_MAX_WORDS} words. This one would start over the limit — it turns red and takes nothing more until it is shorter.`
        : `Cards are meant to be short — up to ${CARD_MAX_WORDS} words.`,
      confirmLabel: "Make card",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
    if (above) {
      const backdrop = document.querySelector(".tree-delete-modal-backdrop");
      if (backdrop) backdrop.style.zIndex = "calc(var(--z-courier) + 1)";
    }
  });
}
