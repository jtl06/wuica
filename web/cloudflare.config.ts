// Deployment of the static site (web/dist, made by web/build.sh) as an assets-only Cloudflare Worker:
//   cd web && ./build.sh && cf deploy ./dist
// The page runs entirely in the browser; the Worker only serves files.
import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "wuica",
    compatibilityDate: "2026-11-22",
    domains: ["wuica.jacen.li"],
    assets: { notFoundHandling: "404-page" },
  },
});
