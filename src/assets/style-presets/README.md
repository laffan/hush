# Preset Styles

Drop any `.json` file shaped like an exported Hush style into this folder
and it will show up in the **Presets…** picker inside *Edit Styles*.

Each file should be a single style object (the same JSON the *Export
style as JSON* button at the bottom of the style editor produces). An
array of styles or a `{ "styles": [...] }` payload also work.

The folder is read at build time via `import.meta.glob`, so adding,
renaming, or removing files takes a fresh `npm run dev` / build to
appear in the running app.
