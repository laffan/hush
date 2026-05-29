# Hush — promotional site

This branch hosts the GitHub Pages landing page for [Hush](https://github.com/laffan/hush),
a minimal, distraction-free writing app.

## Structure

```
index.html    Page markup
styles.css    Styles (minimal, type-forward)
scripts.js    Footer year + reveal-on-scroll
img/          Screenshots (see img/README.md for filenames)
```

## Local preview

Open `index.html` directly in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

In the repository settings, set **Pages → Build and deployment → Source**
to *Deploy from a branch*, and choose this branch with the `/ (root)` folder.
