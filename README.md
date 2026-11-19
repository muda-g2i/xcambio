# CambioX

Convierte bolívares y dólares al instante con la tasa **BCV** y la tasa **P2P**.
Static PWA (HTML + CSS + ES modules, no build step) hosted on GitHub Pages; works offline once opened.

## How it works

- Three linked amounts: **Bolívares**, **Dólares BCV**, **Dólares P2P**. The amount you type is never
  recalculated; the other two follow it. Editing a rate only changes the derived amounts.
- Rates: one request to [dolarapi.com](https://dolarapi.com) `GET https://ve.dolarapi.com/v1/dolares`
  returns both the official (BCV) and parallel rates.
- Tap a rate to type your own; ↺ on the tile (or the refresh button) goes back to the day's rate.

## Caching

| What | Where | Strategy |
| --- | --- | --- |
| App shell (HTML, CSS, JS, fonts, icons) | Service worker cache `cambiox-<commit>` | Precached, cache-first; a new deploy changes `sw.js`, installs a fresh cache and removes the old one |
| Rates | `localStorage` (`cambiox:rates`) + browser HTTP cache | Shown instantly from storage, then revalidated. dolarapi sends an ETag with `max-age=0, must-revalidate`, so unchanged rates cost a 304. Refreshed on launch, when the app returns to the foreground (>5 min), every 10 min while open and when the connection comes back |
| Refresh button | — | `fetch(..., { cache: "no-cache" })`: always revalidates with the server and replaces manual rates |

The service worker deliberately does not cache the API, so it can never serve an outdated rate.

## Develop

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/ (the service worker works on localhost).

```bash
npm test
```

`core.js` holds the pure logic (parsing, formatting, conversion, keypad editing) and is covered by `core.test.js`.
`app.js` is the UI.

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml`: tests, stamps `sw.js` with the commit SHA, publishes to Pages.
Settings → Pages → Source must be **GitHub Actions**.
