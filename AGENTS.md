# AGENTS.md

Guidance for AI coding agents working on CambioX. Read [README.md](README.md) first for what the app does,
caching, and how to run, test and deploy it. This file covers the rules and context the README does not.

## Ground rules

- **Static site, no build step, no dependencies.** Plain HTML, CSS and ES modules served as-is by GitHub Pages.
  Don't add a bundler, framework, npm runtime dependency or CDN. `package.json` exists only for `npm test`.
- **Everything is self-hosted** (fonts, icons) so the installed app starts with zero network requests.
- **Relative paths only** (`sw.js`, `manifest.json`, `fonts/...`). The site is served under `/xcambio/` on
  GitHub Pages and from `/` locally. Never hard-code `/xcambio/`.
- **Language:** code, comments, docs, tests and commit messages in English. All user-facing copy (UI text,
  toasts, `aria-label`s, manifest `name`/`description`) in Spanish for Venezuela (`es-VE`).
- **Never rename the repository.** The Pages URL is the installed app's identity; renaming breaks every install.
- Keep it working offline and on small phones (see Checks).

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup only. SVG icon sprite at the top of `<body>`. |
| `style.css` | All styles. Design tokens in `:root`, dark mode in the `prefers-color-scheme` block. |
| `core.js` | Pure logic, no DOM: parsing, formatting, keypad editing, conversion, API parsing, dates. |
| `app.js` | UI: state, `render()`, events, network, storage, service worker registration. |
| `sw.js` | Service worker: precaches the app shell, cache-first. |
| `core.test.js` | Unit tests (`node:test`) for `core.js`. |
| `manifest.json` | PWA manifest (icons, screenshot, colors). |
| `fonts/` | Space Grotesk (numbers, headings) and Inter (UI), latin subset, variable weight, OFL. |
| `icons/` | App icon (SVG sources + PNGs), header mark, browser-tab icon. See Icons. |
| `scripts/` | Dev-only icon tooling (`build-icons.js`, `text-to-path.py`). Not used by the app. |
| `screenshots/` | Screenshot shown in Chrome's install dialog (`manifest.json`). |

## Domain model

- Three **amount** fields: `bs` (bolívares), `bcv` (dollars at the official rate), `usdt` (USDT).
- Two **rates** in bolívares per dollar: `bcv` and `usdt`. Rate keys match the amount they convert.
- Naming: dolarapi.com calls the market rate `paralelo`; the code uses `usdt`; the UI says **USDT**.
  Don't reintroduce "paralelo" or "P2P" as labels: in 2025 Venezuelan authorities arrested people for
  publishing "dólar paralelo" rates, and USDT is the reference people use now. (The rate tracks the P2P
  USDT market closely; it is not a Binance quote.)
- **Rates are rounded to 2 decimals** (`roundRate`) when they arrive and are used that way for display,
  maths and sharing, so a hand check matches the screen. Manual rates are limited to 2 decimals.
- Number format is es-VE: `1.234,56`. `formatNumber` forces grouping (`useGrouping: "always"`).
  `parseAmount` accepts both `,` and `.` decimals.

## State and invariants (`app.js`)

`state` is the single source of truth; `render()` rewrites the DOM from it.

- `active`: field the keypad types into (`bs`, `bcv`, `usdt`, `rate:bcv`, `rate:usdt`).
- `entry`: raw text being typed (`"1234,5"`), or `null` when the field was just selected. While `null` the
  value shows as selected and the next key replaces it (⌫ clears it).
- `anchor` / `anchorValue`: the amount typed last. **Never recalculate the anchor**; changing a rate
  only updates the other two amounts (`convertAll`).
- `rates` (in use), `api` (last fetched `{ rate, date }`), `manual` (per rate, typed by hand).
  Automatic refreshes keep manual rates; the refresh button (`force: true`) and ↺ replace them.
  A manual rate left empty goes back to the automatic one. Manual rates are never persisted.

## Network and caching

- One request: `GET https://ve.dolarapi.com/v1/dolares` (CORS `*`, ETag, `max-age=0, must-revalidate`).
  Automatic loads use `cache: "default"` (conditional request, 304 when unchanged); the refresh button
  uses `cache: "no-cache"`. Timeout 8 s. Don't use `no-store`: it throws away the ETag.
- Don't add custom request headers: they trigger a CORS preflight.
- The service worker must not cache the API (it returns early for cross-origin requests).
- Alternatives checked in Nov 2026: Cotizave (needs an API key), bcv.today (BCV only), CriptoYa and
  Yadio (USDT/P2P only), pydolarve (down). dolarapi is the only free, keyless, CORS-enabled source with both.

## Service worker (`sw.js`)

- When you add a file the app needs at start-up, **add it to `APP_SHELL`**, or the app breaks offline.
- `VERSION` is `'dev'` in the repo; the deploy workflow replaces it with the commit SHA. A new `sw.js`
  installs a fresh cache, `skipWaiting()`s, deletes old caches, and the new version shows on the next launch.
- Navigations are answered with the cached `./` (ignoring query strings).

## Storage (`localStorage`)

| Key | Content |
| --- | --- |
| `cambiox:rates` | `{ bcv: {rate, date}, usdt: {rate, date}, fetchedAt }` |
| `cambiox:amount` | `{ anchor, value }`, the last typed amount |
| `cambiox:hint-rates-seen` | `true` once the one-time "tap a rate" hint was dismissed |
| `cambiox:theme` | `"light"` / `"dark"` when the user overrides the theme; `null` or absent = automatic |

Migrations in `loadSaved()`: the first version's keys `cambio-ve:bcv-rate` / `cambio-ve:parallel-rate`
(moved, then deleted) and the old `p2p` key (now `usdt`). If you change a stored shape, migrate it there;
installed users carry old data.

## Design system

- Palette A: emerald brand (`--brand #059669`, header `#047857 → #065F46`) on a mint-tinted neutral
  (`--bg #EDF5F0`). **BCV is marked in blue** (`--bcv`: "$" in a blue circle on the rate card, blue badge).
  **USDT uses the Tether mark** (teal `#26A17B` circle with ₮, sprite symbol `#i-tether`) on the rate card
  and as its amount badge. Every other color is a token in `:root` with a dark override; don't
  hard-code colors in rules.
- **Light/dark theme** is driven by `data-theme="light|dark"` on `<html>`, never by
  `@media (prefers-color-scheme)` in CSS. Dark tokens live in `:root[data-theme="dark"]`; component tweaks
  use `[data-theme="dark"] .selector`. An inline script in `<head>` sets the attribute (and the
  `theme-color` metas) before the first paint from `cambiox:theme`, falling back to the system setting.
  It mirrors `resolveTheme()` in `core.js`; keep the two in sync. The header button cycles
  automatic → opposite of the system → same as the system → automatic (`nextTheme()`), so the first tap
  always changes what you see; while automatic, the app follows system changes live.
- Editable things are boxed (rate cards and amount cards share the same field look). Rate cards show ✎
  when automatic, ↺ when manual, and a chip: "Automática · hoy" / "Manual" / "Escribe tu tasa".
- The active field gets an emerald ring and a caret; a just-selected value gets a selection highlight.
- Fonts: Space Grotesk for numbers and headings, Inter for UI text. Don't use `font-variant-numeric:
  tabular-nums`: Space Grotesk's tabular "1" has a slab foot that looks wrong.
- Layout: header with rates, three amount cards overlapping it, keypad pinned to the bottom (thumb zone).
  Two compact breakpoints (`max-height: 700px`, `max-height: 620px`) keep everything on one screen.
- iOS: the status bar is `black-translucent`, so the emerald header sits under it; keep the header
  dark enough for white status-bar text, and respect `env(safe-area-inset-*)`.
- Contrast: aim for WCAG AA (4.5:1) on text. White on the header top `#047857` is 5.5:1.

## Icons

- **App icon** (home screen, install dialog, splash): "Bs ⟳ $", the letters Bs and $ with two curved
  exchange arrows, white on an emerald gradient (`#10B981 → #047857`). No app name inside the icon; the home
  screen already prints it underneath.
- **Header mark** (`icons/mark.svg`): the same artwork in emerald on a white tile, so it stands out on the
  emerald header.
- **Browser-tab icon** (`icons/favicon.svg`, `icons/favicon-48.png`): deliberately simpler, a green tile with
  a big white X, because the letters are unreadable at 16 px.
- Letters are **outlined paths** (Space Grotesk Bold, via `scripts/text-to-path.py`), so the SVGs never
  depend on installed fonts. To change them, regenerate the paths and paste them into the SVGs.
- Sources and outputs in `icons/`:

  | Source | Output | Rules |
  | --- | --- | --- |
  | `icon.svg` | `icon-192.png`, `icon-512.png` | purpose `any`; transparent rounded corners are fine |
  | `icon-maskable.svg` | `icon-maskable-512.png` | full-bleed square, artwork inside the central 80% (Android masks it) |
  | `apple-touch-icon.svg` | `apple-touch-icon.png` (180×180) | full-bleed, **no transparency** (iOS fills it with black), no rounded corners (iOS rounds it) |
  | `favicon.svg` | `favicon-48.png` | PNG fallback for browsers without SVG favicons |

- Regenerate the PNGs with `node scripts/build-icons.js` (needs Playwright + Chromium), then shrink them
  (e.g. Pillow `optimize=True`, or `oxipng`). If a file name changes, update `index.html`, `manifest.json`
  and `APP_SHELL` in `sw.js`.

## Checks before you push

1. `npm test`
2. Serve the parent of the repo so the app runs under `/xcambio/` like on Pages:
   `mkdir -p /tmp/www && ln -sfn "$PWD" /tmp/www/xcambio && python3 -m http.server 8765 -d /tmp/www`
3. In a browser (Playwright is fine), check: iPhone SE (320×568), iPhone 13 (390×664), Pixel 7, desktop
   (1280×860), light and dark. No vertical scroll on phones, no horizontal overflow, no console errors.
4. Offline: load once, go offline, reload; the app opens and the keypad works.
5. Installability: Chrome DevTools Protocol `Page.getInstallabilityErrors` returns `[]`.

## Deploy and environments

- `muda-g2i/xcambio` (this fork) → https://muda-g2i.github.io/xcambio/: test deployment. Pushing to `main`
  deploys it (`.github/workflows/pages.yml`).
- `mudafar/xcambio` (upstream) → https://mudafar.github.io/xcambio/: the original site with installed
  users. It still runs the first version; changes reach it only when merged upstream by the owner.
