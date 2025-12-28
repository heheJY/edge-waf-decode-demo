export default {
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", { status: 404 });
    }

    let bodyText = await req.text();
    if (bodyText.length > 64 * 1024) bodyText = bodyText.slice(0, 64 * 1024);

    let body;
    try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText }; }

    const meta = {
      origin: true,
      received_headers: {
        "x-cf-ai-router": req.headers.get("x-cf-ai-router") || null,
        "x-cf-ai-suspicious": req.headers.get("x-cf-ai-suspicious") || null,
        "x-cf-ai-normalized": req.headers.get("x-cf-ai-normalized") || null,
        "x-inspect-hop": req.headers.get("x-inspect-hop") || null,
      },
      received_preview: preview(body),
    };

    return Response.json({
      id: "demo-response",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "demo-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK (demo origin). Check meta.* for what happened." },
          finish_reason: "stop",
        }
      ],
      meta,
    });
  }
};

function preview(obj) {
  try {
    const s = JSON.stringify(obj);
    return s.length > 500 ? s.slice(0, 500) + "…" : s;
  } catch {
    return String(obj).slice(0, 500);
  }
}
