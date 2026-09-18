# Vendored front-end libraries

Everything the browser loads is served from this box. Nothing here comes from a CDN at runtime.

## Why

These used to load from `cdnjs.cloudflare.com`. That put a third party on the critical path of a
tool used to fix outages — and when it did not load, every `<i class="ti">` rendered as nothing,
which turned an icon-only button into a blank rectangle nobody could identify. A management
platform that goes blank because someone else's CDN is unreachable is not a management platform.

Self-hosting also means the PWA genuinely works offline: the service worker precaches these into
`ASSET_CACHE`, so a technician in a basement with no signal still gets a usable interface.

## What is here

| Path | Package | Version | Notes |
|---|---|---|---|
| `tabler-icons/` | `@tabler/icons-webfont` | 2.47.0 | **woff2 only** — see below |
| `leaflet/` | `leaflet` | 1.9.4 | CSS, JS and the marker/layer images its CSS references |
| `chartjs/` | `chart.js` | 4.4.1 | UMD build, because the app is a classic script, not a module |

Licences are kept alongside each one.

### The icon font is woff2 only

The upstream package ships `.eot`, `.ttf`, `.woff` and `.woff2` — 5.4 MB of which 4.6 MB is
formats no browser this app supports would ever request. `tabler-icons.css` here has had its
`@font-face` `src` rewritten to list woff2 alone. Any browser that can run a service worker can
read woff2, so nothing is lost.

The font is the full ~5,000-glyph set even though the app uses about 113. Subsetting would cut it
to roughly 15 KB, but it needs a build step, and this repository deliberately has none — no
bundler, no transpiler, no native dependencies. It also introduces a trap: an icon added later but
missing from the subset renders as nothing, which is the exact failure this work removed. If first
load over cellular ever matters enough, subset it *and* add a test asserting every `ti-*` class
used in `app.js` exists in the font.

## Updating

There is no build step. Install the version you want and copy the files in:

```sh
cd /tmp && npm install --no-save leaflet@X.Y.Z chart.js@X.Y.Z @tabler/icons-webfont@X.Y.Z

# Leaflet — the images are not optional, leaflet.css references them by relative path
cp node_modules/leaflet/dist/leaflet.{css,js}        public/vendor/leaflet/
cp node_modules/leaflet/dist/images/*.png            public/vendor/leaflet/images/

# Chart.js
cp node_modules/chart.js/dist/chart.umd.js           public/vendor/chartjs/

# Tabler — copy the woff2, then rewrite the @font-face src to reference only it
cp node_modules/@tabler/icons-webfont/fonts/tabler-icons.woff2 public/vendor/tabler-icons/fonts/
#   then edit tabler-icons.css so the src is exactly:
#   src:url("./fonts/tabler-icons.woff2") format("woff2")
```

Then bump `VERSION` in `public/sw.js`, or clients keep serving the old files out of cache.

`test/pwa.mjs` asserts that no page references an external host and that every file listed above
exists and is reachable, so a half-finished update fails the suite rather than the browser.
