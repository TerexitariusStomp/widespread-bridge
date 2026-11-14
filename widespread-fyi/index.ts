// widespread-fyi — transparent proxy from the widespread.fyi custom
// domain to the real widespread-bridge worker. The zone lives on a
// different Cloudflare account than the worker, so this worker holds
// the custom domain and forwards bytes untouched (method, headers,
// body) — MCP, A2A, feed, case files all work as if served directly.

const UPSTREAM = "https://widespread.fyi";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return fetch(new Request(UPSTREAM + url.pathname + url.search, req));
  },
} satisfies ExportedHandler;
