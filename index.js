// Uptime Keeper - Telegram bot on Cloudflare Workers + D1
// Pings every saved link on its own interval so sleeping hosts (like Render free) stay awake.

// ---------- SETTINGS (change these if you like) ----------
const MIN_INTERVAL = 5;          // minimum minutes between pings
const MAX_INTERVAL = 1440;       // maximum minutes (24 hours)
const MAX_LINKS_PER_USER = 5;    // links each person can add
const MAX_PINGS_PER_RUN = 35;    // pings per minute (free plan allows ~50 outgoing requests per run)
const MAX_ALERTS_PER_RUN = 10;   // Telegram alerts per minute
const PING_TIMEOUT_MS = 15000;   // wait up to 15s for a site to answer
const FAILS_BEFORE_DOWN = 2;     // failed checks in a row before sending a DOWN alert
// ----------------------------------------------------------

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      url TEXT NOT NULL,
      interval_min INTEGER NOT NULL,
      next_run INTEGER NOT NULL,
      last_status TEXT,
      last_code INTEGER,
      last_check INTEGER,
      fail_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_links_next ON links(next_run)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_links_chat ON links(chat_id)'),
  ]);
  schemaReady = true;
}

// ---------- Telegram helpers ----------
async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return null;
  }
}

const send = (env, chatId, text) =>
  tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  });

// ---------- Link checking ----------
function parseUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return { error: 'Please send a website link.' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: 'That is not a valid link.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http and https links are allowed.' };
  if (u.username || u.password) return { error: 'Links with a username or password are not allowed.' };
  if (u.port) return { error: 'Custom ports are not allowed.' };
  const h = u.hostname.toLowerCase();
  if (
    !h.includes('.') ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return { error: 'That address is not allowed.' };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h.startsWith('[')) {
    return { error: 'IP addresses are not allowed. Use a website name.' };
  }
  return { url: u.toString() };
}

async function ping(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'user-agent': 'UptimeKeeperBot/1.0' },
    });
    try { await r.body?.cancel(); } catch {}
    return { ok: r.status < 500, code: r.status };
  } catch (e) {
    return { ok: false, code: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Scheduled job (runs every minute) ----------
async function runChecks(env) {
  await ensureSchema(env.DB);
  const now = Date.now();
  const { results } = await env.DB
    .prepare('SELECT * FROM links WHERE next_run <= ? ORDER BY next_run ASC LIMIT ?')
    .bind(now, MAX_PINGS_PER_RUN)
    .all();
  if (!results || !results.length) return;

  const outcomes = await Promise.all(
    results.map(async (link) => ({ link, ...(await ping(link.url)) }))
  );

  const updates = [];
  const alerts = [];

  for (const o of outcomes) {
    const l = o.link;
    let status = l.last_status;
    let fails = o.ok ? 0 : l.fail_count + 1;

    if (o.ok) {
      if (l.last_status === 'down') {
        alerts.push({ chat: l.chat_id, text: `🟢 BACK UP: ${l.url}` });
      }
      status = 'up';
    } else if (fails >= FAILS_BEFORE_DOWN && l.last_status !== 'down') {
      status = 'down';
      alerts.push({
        chat: l.chat_id,
        text: `🔴 DOWN: ${l.url}\nNo good answer after ${fails} checks in a row.`,
      });
    }

    // 30s slack so the minute-based timer never skips a round
    const nextRun = now + l.interval_min * 60000 - 30000;
    updates.push(
      env.DB
        .prepare('UPDATE links SET last_status=?, last_code=?, last_check=?, fail_count=?, next_run=? WHERE id=?')
        .bind(status, o.code, now, fails, nextRun, l.id)
    );
  }

  await env.DB.batch(updates);
  await Promise.all(alerts.slice(0, MAX_ALERTS_PER_RUN).map((a) => send(env, a.chat, a.text)));
}

// ---------- Telegram commands ----------
function helpText() {
  return (
    `Uptime Keeper 🟢\n` +
    `Send me a website link and I will visit it on a schedule so it stays awake.\n\n` +
    `/add <link> <minutes> - start pinging (${MIN_INTERVAL} to ${MAX_INTERVAL} minutes)\n` +
    `/list - see your links\n` +
    `/remove <id> - stop pinging a link\n` +
    `/help - show this message\n\n` +
    `Example: /add https://mysite.com 5\n` +
    `Limit: ${MAX_LINKS_PER_USER} links per person.\n` +
    `I will message you if a site goes down and when it comes back.`
  );
}

async function handleMessage(env, msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  await ensureSchema(env.DB);

  if (!text.startsWith('/')) {
    return send(env, chatId, 'Send /help to see what I can do.');
  }

  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    return send(env, chatId, helpText());
  }

  if (cmd === '/add') {
    const parsed = parseUrl(args[0]);
    if (parsed.error) return send(env, chatId, `❌ ${parsed.error}\nExample: /add https://mysite.com 5`);

    const minutes = args[1] ? Number(args[1]) : MIN_INTERVAL;
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL || minutes > MAX_INTERVAL) {
      return send(env, chatId, `❌ Minutes must be a whole number from ${MIN_INTERVAL} to ${MAX_INTERVAL}.`);
    }

    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM links WHERE chat_id=?').bind(chatId).first('c');
    if (count >= MAX_LINKS_PER_USER) {
      return send(env, chatId, `❌ You already have ${MAX_LINKS_PER_USER} links. Use /remove <id> to free a slot.`);
    }

    const dupe = await env.DB.prepare('SELECT id FROM links WHERE chat_id=? AND url=?').bind(chatId, parsed.url).first();
    if (dupe) return send(env, chatId, `ℹ️ That link is already on your list (#${dupe.id}).`);

    const now = Date.now();
    const res = await env.DB
      .prepare('INSERT INTO links (chat_id, url, interval_min, next_run, created_at) VALUES (?,?,?,?,?)')
      .bind(chatId, parsed.url, minutes, now, now)
      .run();
    const id = res.meta.last_row_id;
    return send(env, chatId, `✅ Added #${id}\n${parsed.url}\nPinging every ${minutes} minutes. First ping within a minute.`);
  }

  if (cmd === '/list') {
    const { results } = await env.DB
      .prepare('SELECT id, url, interval_min, last_status, last_code FROM links WHERE chat_id=? ORDER BY id')
      .bind(chatId)
      .all();
    if (!results.length) return send(env, chatId, 'You have no links yet. Use /add <link> <minutes>.');
    const lines = results.map((l) => {
      const icon = l.last_status === 'up' ? '✅' : l.last_status === 'down' ? '🔴' : '⏳';
      const code = l.last_code ? ` (code ${l.last_code})` : '';
      return `${icon} #${l.id} ${l.url}\nevery ${l.interval_min} min${code}`;
    });
    return send(env, chatId, lines.join('\n\n'));
  }

  if (cmd === '/remove') {
    const id = Number(args[0]);
    if (!Number.isInteger(id)) return send(env, chatId, 'Use: /remove <id>  (see ids with /list)');
    const res = await env.DB.prepare('DELETE FROM links WHERE id=? AND chat_id=?').bind(id, chatId).run();
    if (!res.meta.changes) return send(env, chatId, `❌ No link #${id} on your list.`);
    return send(env, chatId, `🗑️ Removed #${id}.`);
  }

  return send(env, chatId, 'I do not know that command. Send /help.');
}

async function handleUpdate(env, update) {
  if (update && update.message && update.message.text) {
    await handleMessage(env, update.message);
  }
}

// ---------- Worker entry ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('Bad request', { status: 400 });
      }
      ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error(e)));
      return new Response('ok');
    }

    // One-time setup: open /setup?key=YOUR_WEBHOOK_SECRET in a browser
    if (url.pathname === '/setup') {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return new Response('Missing BOT_TOKEN or WEBHOOK_SECRET. Add them in Cloudflare under Settings > Variables and Secrets.', { status: 500 });
      }
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      const result = await tg(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message'],
      });
      return new Response(JSON.stringify(result, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Uptime Keeper is running.');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env).catch((e) => console.error(e)));
  },
};
