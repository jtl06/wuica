# Serving the WebAssembly modules precompressed (proposal, not deployed)

The host compresses static assets on the fly at a low brotli level and has no setting for the level (Compression Rules
pick only the algorithm). Measured on the live site (0.1.8) against brotli -q 11 of the same files:

| file | served | brotli -q 11 |
|---|---:|---:|
| `wuica_wasm.wasm` (with names, 0.1.8) | 866,526 | 629,775 |
| `wuica_wasm.wasm` (stripped, after 0.1.8) | ~775,000 (-q 2, close to the host) | 569,418 |
| `wuica_asm.wasm` | 941,580 | 687,897 |
| `wuica_mca.wasm` | 1,103,294 | 801,898 |

The two modules of a first visit in assembly mode: ~1,757 kB as served after the strip, 1,257 kB at -q 11 (-500 kB).
Time to the first result of a fresh visit in headless Chrome (local host serving brotli, median of 3; docs/PORTING.md,
"Size of the modules"): 10 Mbit/s, 40 ms: 2,499 -> 2,084 ms; 4 Mbit/s, 80 ms: 5,567 -> 4,548 ms; unthrottled: no change.

## The change

1. `web/build.sh` writes `wuica_wasm.wasm.br`, `wuica_asm.wasm.br` and `wuica_mca.wasm.br` next to the modules (brotli -q 11,
   window 24, with Node's zlib as `packages/wuica/build.sh` does). The `.br` files stay out of `manifest.json`, so the
   service worker does not precache them; it keeps fetching `wuica_wasm.wasm` and gets the decoded bytes.
2. A Worker that runs only for the modules (`run_worker_first`), so every other request stays a free static-asset request:

```ts
// web/worker.ts
interface Env { ASSETS: Fetcher }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const br = /\bbr\b/.test(request.headers.get("Accept-Encoding") ?? "");
    if (br && (request.method === "GET" || request.method === "HEAD") && !request.headers.has("Range")) {
      const res = await env.ASSETS.fetch(new Request(new URL(url.pathname + ".br", url), {
        method: request.method, headers: { "If-None-Match": request.headers.get("If-None-Match") ?? "" },
      }));
      if (res.ok || res.status === 304) {
        const headers = new Headers(res.headers);
        headers.set("Content-Type", "application/wasm");
        headers.set("Content-Encoding", "br");
        headers.set("Vary", "Accept-Encoding");
        return new Response(res.body, { status: res.status, headers, encodeBody: "manual" });
      }
    }
    return env.ASSETS.fetch(request); // no br, a range request, or no .br file: the asset as the host serves it
  },
};
```

```ts
// web/cloudflare.config.ts
import { defineConfig } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };
export default defineConfig({
  worker: {
    name: "wuica",
    compatibilityDate: "2026-11-22",
    domains: ["wuica.jacen.li"],
    entrypoint,
    assets: { notFoundHandling: "404-page", runWorkerFirst: ["/*.wasm"] },
  },
});
```

`encodeBody: "manual"` tells the runtime that the body is already encoded, so it is sent as it is with the
`Content-Encoding` given; the browser decodes it as it does now, and the page's `fetch` (progress from the decoded length,
which `manifest.json` gives) and `WebAssembly.compile` see the same bytes.

## Open points (check before deploying)

- Cost: the static-asset requests stay free and unlimited; each module request becomes a Worker invocation (at most three
  per visit without a cached service worker, none after). On the free plan, requests beyond the daily Worker limit get
  a 429 instead of the asset (the static-assets billing page), so a module request could fail where it now always works;
  `/*.wasm` limits this to the module requests.
- Not run here: `cf dev` needs a dev server package (the Vite plugin or Wrangler) that the project does not install, and
  the Miniflare bundled with `cf` (a beta) did not take the old options. The effect on the wire was measured with the
  repository's own host (`tests-js/static-host.mjs` serving the `-q 11` bytes); test the Worker in a preview deployment
  first: `curl -sI -H 'Accept-Encoding: br' URL/wuica_wasm.wasm` must show `content-encoding: br` and a body of 569 kB,
  `-H 'Accept-Encoding: gzip'` the host's own compression, `-H 'Range: bytes=0-99'` a 206 from the asset.
- The documentation of static assets says nothing about `Content-Encoding` on assets or about whether `env.ASSETS.fetch`
  answers `If-None-Match` and `Range`; the code passes the first and leaves range requests to the asset.
- The edge cache: responses from a Worker are not cached by the static-asset cache; each module request reads the
  `.br` asset through the binding (an asset read, no origin). `Vary: Accept-Encoding` keeps the browser's cache correct.
- The tables (`data/arch/*.json`) could be served the same way (1,281 kB served vs 681 kB at -q 11 for the 15), but they
  are being replaced by a binary form in this release: measure again then.
- Without the Worker (or if it is not wanted), the page could fetch `.br` files and decode them itself, but Chrome 157's
  `DecompressionStream` has no `brotli` (Firefox has it since 147, Node has it), so Chrome would need a brotli decoder
  in JavaScript or WebAssembly (the static dictionary alone is 122 kB raw), downloaded before the modules and run before
  `WebAssembly.compile`; gzip, which `DecompressionStream` has everywhere, is larger than the host's brotli (816,848 for the
  stripped analyzer at gzip -9).
