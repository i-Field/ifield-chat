// worker.js — ifield P2P Chat signaling relay
// Приватность: храним только SDP на 5 минут. Без логов, без IP, без аккаунтов.

const TTL = 300;         // 5 минут — жизнь комнаты в KV
const MAX_SIZE = 8000;   // макс размер SDP (защита от спама)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      // Всё, что не /api/* — отдаём как статику (index.html и т.п.)
      if (!url.pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      // POST /api/room/new — создать комнату, получить код
      if (url.pathname === '/api/room/new' && request.method === 'POST') {
        for (let i = 0; i < 5; i++) {
          const code = generateCode();
          const exists = await env.IFIELD_CRYPTO_KV.get(`room:${code}:offer`);
          if (!exists) return json({ code }, 200, cors);
        }
        return json({ error: 'busy' }, 503, cors);
      }

      // GET|POST|PUT /api/room/:code/offer или /answer
      const m = url.pathname.match(/^\/api\/room\/([a-z0-9]{6})\/(offer|answer)$/);
      if (m) {
        const [, code, type] = m;
        const key = `room:${code}:${type}`;

        if (request.method === 'GET') {
          const val = await env.IFIELD_CRYPTO_KV.get(key);
          if (!val) return json({ error: 'not_found' }, 404, cors);
          return json({ data: val }, 200, cors);
        }

        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await request.text();
          if (body.length === 0 || body.length > MAX_SIZE) {
            return json({ error: 'bad_size' }, 413, cors);
          }
          await env.IFIELD_CRYPTO_KV.put(key, body, { expirationTtl: TTL });
          return json({ ok: true }, 200, cors);
        }
      }

      // POST /api/room/:code/cleanup — стереть комнату после соединения
      const cm = url.pathname.match(/^\/api\/room\/([a-z0-9]{6})\/cleanup$/);
      if (cm && request.method === 'POST') {
        const code = cm[1];
        await Promise.all([
          env.IFIELD_CRYPTO_KV.delete(`room:${code}:offer`),
          env.IFIELD_CRYPTO_KV.delete(`room:${code}:answer`),
        ]);
        return json({ ok: true }, 200, cors);
      }

      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server_error' }, 500, cors);
    }
  }
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// Без похожих символов (нет 0/O, 1/l/i) — чтобы код было легко диктовать
function generateCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
  return code;
}
