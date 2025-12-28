export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", { status: 404 });
    }

    // Only router can call inspect
    if (req.headers.get("x-cf-ai-router") !== "1") {
      return new Response("Forbidden (must call via ai.<zone> router)", { status: 403 });
    }

    // Service binding required
    if (!env.ORIGIN || typeof env.ORIGIN.fetch !== "function") {
      return new Response("Server misconfig: ORIGIN service binding missing", { status: 500 });
    }

    const headers = new Headers(req.headers);
    headers.set("x-inspect-hop", "1");
    headers.set("cache-control", "no-store");

    // Hard timeout (edge safety)
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort("origin timeout"), 8000);

    try {
      return await env.ORIGIN.fetch(req.url, {
        method: "POST",
        headers,
        body: await req.text(),
        signal: ac.signal,
      });
    } catch (e) {
      return new Response(`inspect->origin failed: ${e}`, { status: 502 });
    } finally {
      clearTimeout(t);
    }
  },
};
