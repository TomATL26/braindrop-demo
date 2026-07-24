/**
 * Braindrop backend — a single-file Cloudflare Worker.
 *
 * Routes:
 *   POST  /telegram          Telegram bot webhook (secret-token verified)
 *   POST  /email?token=...   Inbound-email webhook (Postmark/Mailgun/SendGrid)
 *   GET   /api/drops         List all drops            (Bearer DASH_TOKEN)
 *   POST  /api/drops         Add a drop  {text}        (Bearer DASH_TOKEN)
 *   PATCH /api/drops/:id     Update      {done|text}   (Bearer DASH_TOKEN)
 *   DELETE /api/drops/:id    Delete                    (Bearer DASH_TOKEN)
 *
 * Also exports an `email()` handler for Cloudflare Email Routing, so a
 * forwarding address like drop@your-domain.com can deliver straight here.
 *
 * Bindings (see wrangler.toml / README):
 *   DROPS             KV namespace
 *   TELEGRAM_TOKEN    secret — bot token from @BotFather
 *   TELEGRAM_SECRET   secret — webhook secret_token you choose
 *   DASH_TOKEN        secret — bearer token for the dashboard API
 *   EMAIL_TOKEN       secret — shared token for the /email webhook
 *   ANTHROPIC_API_KEY secret — optional; enables Claude classification
 */
"use strict";

const KV_KEY = "drops";
const MAX_DROPS = 2000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === "/telegram" && request.method === "POST") return telegram(request, env);
      if (url.pathname === "/email" && request.method === "POST") return emailWebhook(request, env, url);
      if (url.pathname.startsWith("/api/drops")) return api(request, env, url);
      return json({ ok: true, service: "braindrop" });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  // Cloudflare Email Routing: route drop@your-domain.com to this Worker.
  async email(message, env) {
    const subject = message.headers.get("subject") || "";
    const raw = await new Response(message.raw).text();
    const body = extractPlainText(raw);
    await captureEmail(env, message.from, subject, body);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function loadDrops(env) {
  return (await env.DROPS.get(KV_KEY, "json")) || [];
}
async function saveDrops(env, drops) {
  await env.DROPS.put(KV_KEY, JSON.stringify(drops.slice(0, MAX_DROPS)));
}

/* ---------------- dashboard API ---------------- */

async function api(request, env, url) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.DASH_TOKEN || auth !== `Bearer ${env.DASH_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const drops = await loadDrops(env);
  const id = url.pathname.split("/")[3];

  if (request.method === "GET") return json(drops);

  if (request.method === "POST") {
    const { text } = await request.json();
    if (!text || !text.trim()) return json({ error: "text required" }, 400);
    const drop = await classify(text.trim(), env, "web");
    drops.unshift(drop);
    await saveDrops(env, drops);
    return json(drop, 201);
  }

  const idx = drops.findIndex((d) => d.id === id);
  if (idx < 0) return json({ error: "not found" }, 404);

  if (request.method === "PATCH") {
    const patch = await request.json();
    if (typeof patch.done === "boolean") drops[idx].done = patch.done;
    if (typeof patch.text === "string" && patch.text.trim()) {
      const re = await classify(patch.text.trim(), env, drops[idx].source);
      drops[idx] = { ...re, id: drops[idx].id, created: drops[idx].created, done: drops[idx].done };
    }
    await saveDrops(env, drops);
    return json(drops[idx]);
  }

  if (request.method === "DELETE") {
    drops.splice(idx, 1);
    await saveDrops(env, drops);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

/* ---------------- Telegram webhook ---------------- */

async function telegram(request, env) {
  if (env.TELEGRAM_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  const update = await request.json();
  const msg = update.message;
  if (!msg || !msg.text) return json({ ok: true });

  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await reply(env, msg.chat.id,
      "🧠 Braindrop — text it, forget it, find it.\n\n" +
      "Send me anything: a task (“pay the water bill tomorrow”), an idea, a link, a quote, a note. " +
      "I'll file it on your dashboard, pull out #tags and due dates, and confirm back.\n\n" +
      "Commands: /due — what needs attention");
    return json({ ok: true });
  }

  if (text === "/due") {
    const drops = await loadDrops(env);
    const now = Date.now();
    const attention = drops
      .filter((d) => d.due && !d.done)
      .filter((d) => d.due < now || new Date(d.due).toDateString() === new Date(now).toDateString())
      .sort((a, b) => a.due - b.due);
    await reply(env, msg.chat.id, attention.length
      ? "⚠ Needs attention:\n" + attention.map((d) => `• ${d.text}`).join("\n")
      : "Nothing overdue or due today. 🎉");
    return json({ ok: true });
  }

  const drop = await classify(text, env, "telegram");
  const drops = await loadDrops(env);
  drops.unshift(drop);
  await saveDrops(env, drops);

  const icons = { task: "✓", idea: "💡", note: "📝", link: "🔗", quote: "❝" };
  let confirmation = `${icons[drop.type]} Filed as ${drop.type}`;
  if (drop.due) {
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: env.TIMEZONE || "America/Chicago",
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(drop.due));
    confirmation += ` · ⏰ ${local}`;
  }
  if (drop.tags.length) confirmation += ` · ${drop.tags.map((t) => "#" + t).join(" ")}`;
  if (drop.priority) confirmation += " · ‼ urgent";
  await reply(env, msg.chat.id, confirmation);
  return json({ ok: true });
}

async function reply(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/* ---------------- email ingestion ---------------- */

/**
 * Generic inbound-email webhook. Works with the JSON payloads of Postmark
 * ({From, Subject, TextBody}) and the form-encoded payloads of Mailgun
 * ("from", "subject", "body-plain") and SendGrid ("from", "subject", "text").
 * Authenticate with ?token=<EMAIL_TOKEN> on the webhook URL.
 */
async function emailWebhook(request, env, url) {
  if (!env.EMAIL_TOKEN || url.searchParams.get("token") !== env.EMAIL_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  let from = "", subject = "", body = "";
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("json")) {
    const p = await request.json();
    from = p.From || p.from || "";
    subject = p.Subject || p.subject || "";
    body = p.TextBody || p["body-plain"] || p.text || p.body || "";
  } else {
    const form = await request.formData();
    from = form.get("from") || "";
    subject = form.get("subject") || "";
    body = form.get("body-plain") || form.get("text") || "";
  }
  const drop = await captureEmail(env, from, subject, body);
  // Plain 200 — Postmark and friends retry (and re-deliver) on anything else.
  return json(drop ? { ok: true, id: drop.id } : { ok: false, error: "empty email" }, drop ? 200 : 400);
}

async function captureEmail(env, from, subject, body) {
  // Forwarded emails bury the content under "Fwd:" headers — strip the noise.
  const cleanSubject = (subject || "").replace(/^((re|fwd?|fw)\s*:\s*)+/i, "").trim();
  const cleanBody = (body || "")
    .split(/^-{3,}\s*Forwarded message\s*-{3,}$/im)[0]
    .replace(/^>.*$/gm, "")
    .trim()
    .slice(0, 2000);
  const text = [cleanSubject, cleanBody].filter(Boolean).join("\n").trim();
  if (!text) return null;

  const drop = await classify(text, env, "email");
  drop.emailFrom = from || undefined;
  const drops = await loadDrops(env);
  drops.unshift(drop);
  await saveDrops(env, drops);
  return drop;
}

/**
 * Minimal MIME text extraction for Cloudflare Email Routing messages:
 * finds the first text/plain part and decodes quoted-printable / base64.
 * Good enough for forwarded personal mail; not a full MIME parser.
 */
function extractPlainText(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, headerEnd < 0 ? 0 : headerEnd);
  let bodyRaw = raw.slice(headerEnd < 0 ? 0 : headerEnd + 4);

  const boundaryMatch = headers.match(/boundary="?([^";\r\n]+)"?/i);
  let partHeaders = headers;
  if (boundaryMatch) {
    const parts = bodyRaw.split("--" + boundaryMatch[1]);
    const textPart = parts.find((p) => /content-type:\s*text\/plain/i.test(p)) || parts[1] || "";
    const split = textPart.indexOf("\r\n\r\n");
    partHeaders = textPart.slice(0, split < 0 ? 0 : split);
    bodyRaw = split < 0 ? textPart : textPart.slice(split + 4);
  }

  if (/content-transfer-encoding:\s*base64/i.test(partHeaders)) {
    try { bodyRaw = atob(bodyRaw.replace(/\s+/g, "")); } catch { /* keep raw */ }
  } else if (/content-transfer-encoding:\s*quoted-printable/i.test(partHeaders)) {
    bodyRaw = bodyRaw
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return bodyRaw.trim();
}

/* ---------------- classification ---------------- */

async function classify(text, env, source) {
  let result = null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      result = await claudeClassify(text, env);
    } catch (e) {
      // fall through to the regex classifier — capture must never fail
      console.log("claude classification failed:", e.message);
    }
  }
  if (!result) result = regexClassify(text);

  return {
    id: crypto.randomUUID().slice(0, 12),
    text,
    type: result.type,
    tags: result.tags,
    due: result.due,
    priority: result.priority,
    done: false,
    created: Date.now(),
    source,
    notified: false,
  };
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["task", "idea", "note", "link", "quote"] },
    tags: { type: "array", items: { type: "string" } },
    due: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    priority: { type: "boolean" },
  },
  required: ["type", "tags", "due", "priority"],
  additionalProperties: false,
};

async function claudeClassify(text, env) {
  // Raw fetch (no SDK): this Worker deploys as a single file with no build step.
  const tz = env.TIMEZONE || "America/Chicago";
  const now = new Date();
  const localNow = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(now);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      output_config: { effort: "low", format: { type: "json_schema", schema: CLASSIFY_SCHEMA } },
      system:
        "You classify short captured notes for a personal thought-capture app. " +
        "Types: task (something to do), idea (a concept or 'what if'), link (mainly a URL), " +
        "quote (quoted words, usually with attribution), note (everything else). " +
        "tags: lowercase topical keywords — explicit #hashtags always, plus at most 2 inferred topics. " +
        `The user's timezone is ${tz}; right now it is ${localNow} there (${now.toISOString()} UTC). ` +
        "due: if the text implies a deadline or reminder time, resolve it in the user's timezone " +
        "(honor an explicit timezone if the text names one; default to 09:00 local when no time is given) " +
        "and output it as an ISO 8601 UTC datetime; else null. " +
        "priority: true only for urgency markers (urgent, asap, '!!', a hard deadline today).",
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("refusal");
  const block = (data.content || []).find((b) => b.type === "text");
  const parsed = JSON.parse(block.text);
  return {
    type: parsed.type,
    tags: parsed.tags.map((t) => t.toLowerCase().replace(/^#/, "")),
    due: parsed.due ? Date.parse(parsed.due) : null,
    priority: parsed.priority,
  };
}

/* Regex fallback — mirrors the dashboard's client-side parser. */
const RE_URL = /(https?:\/\/[^\s<]+)/i;
const RE_TASK = /\b(todo|to-do|remind me|need(s)? to|don'?t forget|must|buy|get|pick up|call|phone|email|text|message|pay|book|schedule|renew|cancel|return|order|fix|repair|clean|finish|submit|file|sign up|register|deadline|due|appointment|rsvp)\b/i;
const RE_IDEA = /^(idea|concept)[:\s]|\b(what if|imagine|app (for|that|idea)|startup|business idea|feature idea|side project)\b/i;
const RE_QUOTE = /^\s*["“].+["”]\s*([—–-].+)?$/s;
const RE_PRI = /(!{2,}|\burgent(ly)?\b|\basap\b|\bimportant\b|\bcritical\b)/i;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function regexClassify(text) {
  const tags = [...text.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase());
  const due = parseWhen(text);
  let type;
  if (RE_QUOTE.test(text)) type = "quote";
  else if (RE_URL.test(text) && text.replace(RE_URL, "").trim().length < 60) type = "link";
  else if (RE_TASK.test(text) || (due && !RE_IDEA.test(text))) type = "task";
  else if (RE_IDEA.test(text)) type = "idea";
  else if (RE_URL.test(text)) type = "link";
  else type = "note";
  return { type, tags, due, priority: RE_PRI.test(text) };
}

function parseWhen(text) {
  const now = new Date();
  const lower = text.toLowerCase();
  let d = null;
  const at = (date, h, m) => { const x = new Date(date); x.setUTCHours(h, m || 0, 0, 0); return x; };

  let m;
  if ((m = lower.match(/\bin (\d+) (minute|min|hour|hr|day|week)s?\b/))) {
    const n = +m[1];
    const x = new Date(now);
    if (/min/.test(m[2])) x.setMinutes(x.getMinutes() + n);
    else if (/h/.test(m[2])) x.setHours(x.getHours() + n);
    else if (m[2] === "day") x.setDate(x.getDate() + n);
    else x.setDate(x.getDate() + 7 * n);
    d = x;
  } else if (/\btomorrow\b/.test(lower)) {
    const x = new Date(now); x.setUTCDate(x.getUTCDate() + 1); d = at(x, 9);
  } else if (/\btonight\b/.test(lower)) {
    d = at(now, 20);
  } else if (/\btoday\b/.test(lower)) {
    d = at(now, 18);
  } else if (/\bnext week\b/.test(lower)) {
    const x = new Date(now); x.setUTCDate(x.getUTCDate() + 7); d = at(x, 9);
  } else if ((m = lower.match(/\b(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const target = DAYS.indexOf(m[2]);
    let delta = (target - now.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    const x = new Date(now); x.setUTCDate(x.getUTCDate() + delta); d = at(x, 9);
  }

  if ((m = lower.match(/\b(?:at|by|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)) && (m[3] || m[2])) {
    let h = +m[1];
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    const x = at(d || now, h, m[2] ? +m[2] : 0);
    if (!d && x < now) x.setUTCDate(x.getUTCDate() + 1);
    d = x;
  }
  return d ? d.getTime() : null;
}
