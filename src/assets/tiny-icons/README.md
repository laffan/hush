# tiny-icons

The icon set behind **Change icon** (desks, folders and projects), vendored
from [laffan/tiny-icons](https://github.com/laffan/tiny-icons) at commit
`f3bf466` — the `icons/` folder, one SVG per icon, copied as-is.

Every file is stroke-only on a 15 × 15 grid (`stroke="currentColor"`,
`stroke-width="1"`). `src/ui/custom-icons.js` reads this folder at build
time through `import.meta.glob`, keeps only each file's inner geometry and
redraws it inside an `<svg>` of its own, so the host's CSS decides colour
and stroke width. The file name (without `.svg`) is the icon's stored
name — `node.icon` on a folder or project, `desksMeta[deskId].icon` on a
desk — so **renaming or removing a file here orphans the nodes that use
it**; they fall back to their default glyph rather than breaking.

To update: delete the `.svg` files here and copy the upstream `icons/*.svg`
in (copying over the top would keep icons upstream has since removed), then
give every new icon a row of search words in `src/ui/custom-icon-keywords.js`
and drop the rows of removed ones. New icons appear in the picker on the next
build; one without a row is still found by its name.
