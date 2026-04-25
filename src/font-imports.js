/**
 * Bundle every Google Font we ship with Hush. JS imports (not CSS @import)
 * so Vite resolves the npm package paths correctly. Each weight/style is
 * imported by file because @fontsource only exposes per-file CSS.
 *
 * Imported for side effects only. main.js pulls this in at startup; no
 * other module should re-import these.
 */
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/600.css";
import "@fontsource/eb-garamond/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-sans-pro/400.css";
import "@fontsource/source-sans-pro/400-italic.css";
import "@fontsource/source-sans-pro/600.css";
import "@fontsource/source-sans-pro/700.css";
import "@fontsource/source-serif-pro/400.css";
import "@fontsource/source-serif-pro/400-italic.css";
import "@fontsource/source-serif-pro/600.css";
import "@fontsource/source-serif-pro/700.css";
import "@fontsource/libre-franklin/400.css";
import "@fontsource/libre-franklin/400-italic.css";
import "@fontsource/libre-franklin/600.css";
import "@fontsource/libre-franklin/700.css";
import "@fontsource/libre-baskerville/400.css";
import "@fontsource/libre-baskerville/400-italic.css";
import "@fontsource/libre-baskerville/700.css";
import "@fontsource/karla/400.css";
import "@fontsource/karla/400-italic.css";
import "@fontsource/karla/600.css";
import "@fontsource/karla/700.css";
import "@fontsource/lora/400.css";
import "@fontsource/lora/400-italic.css";
import "@fontsource/lora/500.css";
import "@fontsource/lora/600.css";
import "@fontsource/lora/700.css";
