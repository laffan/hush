# Brush atlases

Drop PNGs here named `brush-1.png` through `brush-5.png`. On page load,
the engine tries to fetch each one and swaps it in for that brush slot as
soon as it decodes. If a file is absent, the corresponding slot falls back
to the built-in soft-round procedural brush. No rebuild or restart needed
— reload the page to pick up new files.

## Atlas format

- **Dimensions:** 512 × 128 PNG (4 variants across, 128 × 128 per cell).
  Other cell counts work too: the engine infers variants from
  `width / height`, so a 768 × 128 atlas is read as 6 variants. Height is
  always the cell size.
- **Color:** alpha mask. Put a black (or any) silhouette on a transparent
  background — only the alpha channel is read. The renderer tints the
  atlas at draw time using a `source-in` composite, so the same PNG
  works for every pen color.
- **Shape:** center the tip in each cell with ~8 px of padding on all
  sides so rotation or scaling doesn't clip.
- **Variant strategy:** 4 subtly different rotations or noise seeds of
  the same tip. The stamper picks variants round-robin on stamp index,
  so repeated stamps don't look identical.

## Flavors

Which personality goes in which slot is up to you, but something like:

| Slot | Suggested character |
|------|---------------------|
| `brush-1.png` | Soft round        |
| `brush-2.png` | Rough charcoal    |
| `brush-3.png` | Hard pencil       |
| `brush-4.png` | Textured marker   |
| `brush-5.png` | Dry brush         |

## Notes

- The **Rough / Grain / Tooth** sliders only re-shape the *fallback*
  procedural brush. Once a PNG has loaded, those sliders no longer
  regenerate its atlas — the PNG is the ground truth for the look.
- The **Textured** toggle is likewise procedural-only.
- Per-stroke: each stroke records which brush was active when it was
  drawn, so changing brushes doesn't alter existing ink.
