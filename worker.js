// worker.js — ifield P2P Chat Backend
const TTL = 300;         // 5 минут — жизнь комнаты в KV
const MAX_SIZE = 8000;   // макс размер SDP

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ========================================================
    // 🛡️ НЕВИДИМЫЙ ОХРАННИК (Защита исходников)
    // ========================================================
    const forbiddenPaths = ['/worker.js', '/wrangler.toml', '/.git', '/package.json', '/package-lock.json'];
    if (forbiddenPaths.includes(url.pathname) || url.pathname.startsWith('/.git/')) {
      return new Response('Not Found', { status: 404 });
    }

    try {
      // ========================================================
      // 🤖 БЕЗОПАСНАЯ НАСТРОЙКА БОТА (Без ввода токена в браузере)
      // ========================================================
      if (url.pathname === '/api/setup/webhook' && request.method === 'GET') {
        if (!env.BOT_TOKEN) return json({ error: 'BOT_TOKEN не задан в Cloudflare' }, 500, cors);
        const tgRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${url.origin}/webhook`);
        const tgData = await tgRes.json();
        return json(tgData, 200, cors);
      }

      // ========================================================
      // 🤖 ВЕБХУК TELEGRAM (Обработка команд и оплат)
      // ========================================================
      if (url.pathname === '/webhook' && request.method === 'POST') {
        return handleTelegramWebhook(request, env);
      }

      // ========================================================
      // 💎 API ДЛЯ ДОНАТОВ (Telegram Stars)
      // ========================================================
      if (url.pathname === '/api/donate/link' && request.method === 'POST') {
        const body = await request.json();
        const amount = parseInt(body.amount, 10) || 50;
        const token = env.BOT_TOKEN; 
        
        if (!token) return json({ error: 'Bot token not configured' }, 500, cors);

        const res = await fetch(`https://api.telegram.org/bot${token}/createInvoiceLink`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Поддержка iField',
            description: 'Добровольный донат на развитие приватного P2P чата',
            payload: `donate_${Date.now()}`,
            currency: 'XTR',
            prices: [{ label: 'Донат', amount: amount }],
            provider_token: '' 
          })
        });
        const data = await res.json();
        if (data.ok) return json({ link: data.result }, 200, cors);
        return json({ error: data.description }, 500, cors);
      }

      // ========================================================
      // 🔐 API ДЛЯ ЧАТА (СИГНАЛИНГ)
      // ========================================================
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/room/new' && request.method === 'POST') {
          for (let i = 0; i < 5; i++) {
            const code = generateCode();
            const exists = await env.IFIELD_CRYPTO_KV.get(`room:${code}:offer`);
            if (!exists) return json({ code }, 200, cors);
          }
          return json({ error: 'busy' }, 503, cors);
        }

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
            if (body.length === 0 || body.length > MAX_SIZE) return json({ error: 'bad_size' }, 413, cors);
            await env.IFIELD_CRYPTO_KV.put(key, body, { expirationTtl: TTL });
            return json({ ok: true }, 200, cors);
          }
        }

        const cm = url.pathname.match(/^\/api\/room\/([a-z0-9]{6})\/cleanup$/);
        if (cm && request.method === 'POST') {
          const code = cm[1];
          await Promise.all([
            env.IFIELD_CRYPTO_KV.delete(`room:${code}:offer`),
            env.IFIELD_CRYPTO_KV.delete(`room:${code}:answer`),
          ]);
          return json({ ok: true }, 200, cors);
        }
      }

      // --- ВСЁ ОСТАЛЬНОЕ ОТДАЕМ КАК СТАТИКУ (index.html) ---
      return env.ASSETS.fetch(request);
      
    } catch (e) {
      return json({ error: 'server_error' }, 500, cors);
    }
  }
};

// ========================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ========================================================
function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

function generateCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
  return code;
}

// ========================================================
// ОБРАБОТКА БОТА (КОМАНДЫ И ПЛАТЕЖИ)
// ========================================================
async function handleTelegramWebhook(request, env) {
  const update = await request.json();
  const token = env.BOT_TOKEN;
  if (!token) return new Response('No token', { status: 500 });

  const callTg = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  // 1. Команда /start
  if (update.message && update.message.text === '/start') {
    const chatId = update.message.chat.id;
    const appUrl = 'https://ifield-chat.qx420.workers.dev/'; 
    
    await callTg('sendMessage', {
      chat_id: chatId,
      text: "🏴‍☠️ Приветствую, капитан!\n\nЭто iField — приватный P2P чат. Твои сообщения шифруются (AES-256) и идут напрямую, без серверов и логов.\n\nЖми кнопку ниже, чтобы войти в защищенный канал!",
      reply_markup: {
        inline_keyboard: [[
          { text: "🔐 Открыть приложение", web_app: { url: appUrl } }
        ]]
      }
    });
  }

  // 2. Подтверждение перед оплатой (Telegram требует за 10 сек)
  if (update.pre_checkout_query) {
    await callTg('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
  }

  // 3. Успешная оплата (Донат)
  if (update.message && update.message.successful_payment) {
    const pay = update.message.successful_payment;
    await env.IFIELD_CRYPTO_KV.put(`donate:${pay.telegram_payment_charge_id}`, pay.total_amount);
    
    await callTg('sendMessage', {
      chat_id: update.message.chat.id,
      text: `💎 Огромное спасибо за поддержку! Вы пожертвовали ${pay.total_amount} ⭐. Это помогает проекту расти!`
    });
  }

  return new Response('OK', { status: 200 });
}
