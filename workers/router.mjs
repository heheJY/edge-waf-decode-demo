export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Debug helper
    if (url.pathname === "/debug") {
      return Response.json({
        ok: true,
        now: new Date().toISOString(),
        host: url.host,
        inspect_host_binding: env.INSPECT_HOST || null,
      });
    }

    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", { status: 404 });
    }

    let raw;
    try {
      raw = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    // Decide suspicious cheaply (fast path)
    const suspicious = looksSuspicious(raw);
    const normalized = suspicious ? normalizeLLMRequest(raw) : raw;

    const forward = `https://${env.INSPECT_HOST}/v1/chat/completions`;
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.set("x-cf-ai-router", "1");
    headers.set("x-cf-ai-suspicious", suspicious ? "1" : "0");
    if (suspicious) headers.set("x-cf-ai-normalized", "1");
    else headers.set("x-cf-ai-normalized", "0");

    // IMPORTANT: once global_fetch_strictly_public is enabled,
    // this subrequest will traverse Workers+WAF for ai-inspect host.
    const resp = await fetch(forward, {
      method: "POST",
      headers,
      body: JSON.stringify(normalized),
    });

    return resp;
  },
};

function looksSuspicious(body) {
  try {
    const s = JSON.stringify(body);
    // Cheap “signals”: encoded fields OR common prefixes OR unusual entropy markers
    if (/"content_(b64|hex|url)"/i.test(s)) return true;
    if (/^(b64:|hex:|urlenc:)/i.test(extractUserText(body) || "")) return true;
    if (/(%[0-9a-f]{2}){6,}/i.test(s)) return true; // heavy url-encoding
    if (/[A-Za-z0-9+/]{80,}={0,2}/.test(s)) return true; // base64-ish blob
    return false;
  } catch {
    return true;
  }
}

function extractUserText(body) {
  return body?.messages?.[0]?.content || "";
}

function normalizeLLMRequest(body) {
  const msg0 = body?.messages?.[0] || {};
  let content = msg0.content || "";

  if (msg0.content_b64) content = safeB64(msg0.content_b64);
  else if (msg0.content_hex) content = safeHex(msg0.content_hex);
  else if (msg0.content_url) content = safeUrlDecode(msg0.content_url);
  else if (/^b64:/i.test(content)) content = safeB64(content.slice(4));
  else if (/^hex:/i.test(content)) content = safeHex(content.slice(4));
  else if (/^urlenc:/i.test(content)) content = safeUrlDecode(content.slice(7));

  return {
    ...body,
    messages: [{ ...msg0, content }],
  };
}

function safeB64(s) {
  try { return atob(s); } catch { return "[decode_error:b64]"; }
}
function safeHex(s) {
  try {
    const clean = s.replace(/[^0-9a-f]/gi, "");
    let out = "";
    for (let i = 0; i < clean.length; i += 2) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
    }
    return out;
  } catch { return "[decode_error:hex]"; }
}
function safeUrlDecode(s) {
  try { return decodeURIComponent(s); } catch { return "[decode_error:url]"; }
}
