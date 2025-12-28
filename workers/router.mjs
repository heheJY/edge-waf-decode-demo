
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Basic debug endpoint
    if (url.pathname === "/debug") {
      return json(
        {
          ok: true,
          now: new Date().toISOString(),
          host: url.host,
          inspect_host_binding: env.INSPECT_HOST || null,
          note: "Use x-demo-skip-decode: 1 to disable normalization for testing.",
        },
        200
      );
    }

    // Only handle the demo endpoint (keep it explicit)
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (!env.INSPECT_HOST) {
      return new Response("INSPECT_HOST binding not set", { status: 500 });
    }

    // Toggle for testing: skip decode/normalization
    const skipDecode = request.headers.get("x-demo-skip-decode") === "1";

    // Guardrails: don't parse giant bodies in a demo
    const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
    if (contentLength > 256 * 1024) {
      return new Response("Request too large", { status: 413 });
    }

    // Read request body
    let rawText = "";
    try {
      rawText = await request.text();
    } catch {
      return new Response("Failed to read body", { status: 400 });
    }

    // Parse JSON
    let body;
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Determine if suspicious / encoded
    const suspicion = detectSuspicious(body);
    const isSuspicious = suspicion.isSuspicious;

    // Optionally normalize (decode + rewrite content field)
    let normalized = false;
    let normalizedBody = body;

    if (isSuspicious && !skipDecode) {
      const res = normalizeBody(body);
      normalizedBody = res.body;
      normalized = res.normalized;
    }

    // Forward to inspect
    const forwardUrl = new URL(request.url);
    forwardUrl.hostname = env.INSPECT_HOST; // route to ai-inspect.<zone>
    // keep same protocol + path + query

    const headers = new Headers(request.headers);

    // Trust chain headers for bypass guard + observability
    headers.set("x-cf-ai-router", "1");
    headers.set("x-cf-ai-suspicious", isSuspicious ? "1" : "0");
    headers.set("x-cf-ai-normalized", normalized ? "1" : "0");
    headers.set("x-demo-skip-decode", skipDecode ? "1" : "0");

    // Make sure JSON content-type is present
    if (!headers.get("content-type")) {
      headers.set("content-type", "application/json");
    }

    // Optional: avoid compression surprises in simple demos
    headers.delete("accept-encoding");

    const outboundBody = JSON.stringify(normalizedBody);

    // Timeouts: Workers fetch has its own limits; we can still bound via AbortController
    const ac = new AbortController();
    const timeoutMs = 8000;
    const to = setTimeout(() => ac.abort("timeout"), timeoutMs);

    let resp;
    try {
      resp = await fetch(forwardUrl.toString(), {
        method: "POST",
        headers,
        body: outboundBody,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(to);
      return new Response(
        [
          "router->inspect failed: " + safeErr(e),
          `forward=${forwardUrl.toString()}`,
          `inspect_host=${env.INSPECT_HOST}`,
        ].join("\n"),
        { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    } finally {
      clearTimeout(to);
    }

    // Return inspect response to client (pass-through)
    // Note: for security, we can choose to pass only content-type and cf-ray; but for demo pass all.
    return resp;
  },
};

/* ------------------------------ Detection ------------------------------ */

function detectSuspicious(body) {
  // We only inspect the first user message for demo simplicity
  const m = getFirstUserMessage(body);
  if (!m) return { isSuspicious: false, why: [] };

  const why = [];

  // Field-based encodings
  if (typeof m.content_hex === "string" && m.content_hex.length > 0) why.push("content_hex");
  if (typeof m.content_b64 === "string" && m.content_b64.length > 0) why.push("content_b64");
  if (typeof m.content_url === "string" && m.content_url.length > 0) why.push("content_url");

  // Prefix-based encodings
  const c = typeof m.content === "string" ? m.content : "";
  if (/^hex:/i.test(c)) why.push("prefix_hex");
  if (/^b64:/i.test(c)) why.push("prefix_b64");
  if (/^urlenc:/i.test(c)) why.push("prefix_urlenc");

  return { isSuspicious: why.length > 0, why };
}

/* ------------------------------ Normalization ------------------------------ */

function normalizeBody(body) {
  const clone = deepClone(body);
  const m = getFirstUserMessage(clone);
  if (!m) return { body: clone, normalized: false };

  let out = null;

  // Priority: explicit fields override prefixes
  if (typeof m.content_hex === "string" && m.content_hex.length > 0) {
    out = safeHexDecode(m.content_hex);
  } else if (typeof m.content_b64 === "string" && m.content_b64.length > 0) {
    out = safeBase64Decode(m.content_b64);
  } else if (typeof m.content_url === "string" && m.content_url.length > 0) {
    out = safeUrlDecode(m.content_url);
  } else if (typeof m.content === "string") {
    const c = m.content;
    if (/^hex:/i.test(c)) out = safeHexDecode(c.slice(4));
    else if (/^b64:/i.test(c)) out = safeBase64Decode(c.slice(4));
    else if (/^urlenc:/i.test(c)) out = safeUrlDecode(c.slice(7));
  }

  if (typeof out === "string" && out.length > 0) {
    // Write normalized plain text into content and remove encoding fields
    m.content = boundString(out, 32768);
    delete m.content_hex;
    delete m.content_b64;
    delete m.content_url;
    return { body: clone, normalized: true };
  }

  return { body: clone, normalized: false };
}

/* ------------------------------ Decoders (safe) ------------------------------ */

function safeHexDecode(hex) {
  try {
    const cleaned = hex.trim().replace(/^0x/i, "").replace(/\s+/g, "");
    if (cleaned.length === 0) return "";
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) return "[decode_error:hex_non_hex_chars]";
    if (cleaned.length % 2 !== 0) return "[decode_error:hex_odd_length]";
    if (cleaned.length > 65536) return "[decode_error:hex_too_large]";

    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < cleaned.length; i += 2) {
      bytes[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "[decode_error:hex_exception]";
  }
}

function safeBase64Decode(b64) {
  try {
    const s = b64.trim();
    if (s.length === 0) return "";
    if (s.length > 65536) return "[decode_error:b64_too_large]";

    // atob expects standard base64
    const decoded = atob(s);
    // Convert binary string to bytes then UTF-8
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "[decode_error:b64_exception]";
  }
}

function safeUrlDecode(s) {
  try {
    const t = s.trim();
    if (t.length === 0) return "";
    if (t.length > 65536) return "[decode_error:url_too_large]";
    // decodeURIComponent throws on malformed sequences
    return decodeURIComponent(t.replace(/\+/g, "%20"));
  } catch {
    return "[decode_error:url_exception]";
  }
}

/* ------------------------------ Helpers ------------------------------ */

function getFirstUserMessage(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return null;
  for (const m of msgs) {
    if (m && typeof m === "object" && m.role === "user") return m;
  }
  return null;
}

function deepClone(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return x;
  }
}

function boundString(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
}

function safeErr(e) {
  try {
    if (!e) return "unknown";
    if (typeof e === "string") return e;
    if (e && typeof e.message === "string") return e.message;
    return JSON.stringify(e);
  } catch {
    return "unknown";
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
