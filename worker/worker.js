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
    if (typeof patch.attentionDismissed === "boolean") drops[idx].attentionDismissed = patch.attentionDismissed;
    if (typeof patch.attentionSnoozed === "boolean") drops[idx].attentionSnoozed = patch.attentionSnoozed;
    if ("attentionUntil" in patch) drops[idx].attentionUntil = patch.attentionUntil || null;
    if (typeof patch.text === "string" && patch.text.trim()) {
      const prev = drops[idx];
      const re = await classify(patch.text.trim(), env, prev.source);
      drops[idx] = {
        ...re,
        id: prev.id,
        created: prev.created,
        done: prev.done,
        body: prev.body,
        emailFrom: prev.emailFrom,
        attentionDismissed: prev.attentionDismissed,
        attentionSnoozed: prev.attentionSnoozed,
        attentionUntil: prev.attentionUntil,
      };
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
    const { attention, stale } = partitionBoard(drops, now);
    let replyText = attention.length
      ? "⚠ Needs attention:\n" + attention.slice(0, 12).map((d) => `• ${d.text}`).join("\n")
      : "Nothing due today or newly overdue. 🎉";
    if (stale.length) {
      replyText += `\n\n${stale.length} older capture${stale.length === 1 ? "" : "s"} still saved — dismiss or snooze them on the dashboard.`;
    }
    await reply(env, msg.chat.id, replyText);
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
  const cleanSubject = (subject || "").replace(/^((re|fwd?|fw)\s*:\s*)+/i, "").trim();
  const { senderNote, content } = splitEmailContent(body || "");
  if (!cleanSubject && !content) return null;

  // Dates inside a forwarded body are usually history ("generated 25 Jul",
  // "Monday, August 3"), not a deadline. Classify the subject and anything
  // the sender typed above the forward; keep the full message for display.
  const signal = [cleanSubject, senderNote].filter(Boolean).join("\n").trim()
    || (content.split("\n").find((line) => line.trim()) || "").trim().slice(0, 240);
  const drop = await classify(signal, env, "email");
  drop.text = cleanSubject || signal.split("\n")[0].slice(0, 180);
  drop.body = content || undefined;
  drop.emailFrom = from || undefined;
  sanitizeCapturedEmail(drop);
  const drops = await loadDrops(env);
  drops.unshift(drop);
  await saveDrops(env, drops);
  return drop;
}

function sanitizeCapturedEmail(drop, now = Date.now()) {
  if (!drop) return drop;
  const day = 24 * 60 * 60 * 1000;
  if (drop.type !== "task") drop.due = null;
  else if (typeof drop.due !== "number" || Number.isNaN(drop.due) || drop.due < now - day) drop.due = null;
  return drop;
}

/**
 * Pull the readable content out of an email body. For forwards, the content
 * lives *inside* the "---------- Forwarded message ----------" block, after
 * its From/Date/Subject/To header lines; any note the sender typed above the
 * marker is kept too.
 */
function splitEmailContent(body) {
  const normalized = body.replace(/\r\n/g, "\n");
  const parts = normalized.split(/^-{2,}\s*Forwarded message\s*-{2,}\s*$/im);
  const note = (parts[0] || "").trim();
  let forwarded = parts.slice(1).join("\n").trim();
  if (forwarded) {
    const lines = forwarded.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i].trim() === "" || /^\s*(from|date|sent|subject|to|cc)\s*:/i.test(lines[i]))) i++;
    forwarded = lines.slice(i).join("\n").trim();
  }
  const content = [note, forwarded].filter(Boolean).join("\n\n")
    .replace(/^>.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
  // Without a forward marker the whole message is `note`. Don't treat that
  // as a sender's instruction — body dates would become deadlines again.
  return { senderNote: forwarded ? note : "", content };
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

// Named collections the user files drops into. Claude puts a matching
// collection first in `tags`, so the dashboard can filter on it.
const COLLECTIONS = ["recipes"];

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
        `The user files some drops into named collections: ${COLLECTIONS.join(", ")}. ` +
        "When a drop belongs to a collection (e.g. a recipe, a link to one, or a dish to try), " +
        "put that collection name FIRST in tags, spelled exactly as listed. " +
        `The user's timezone is ${tz}; right now it is ${localNow} there (${now.toISOString()} UTC). ` +
        "due: set ONLY when type is task AND the text itself asks for a reminder or deadline " +
        "(tomorrow, next Friday, by March 3, a time to do the thing). Resolve that in the user's timezone " +
        "(honor an explicit timezone if the text names one; default to 09:00 local when no time is given) " +
        "and output an ISO 8601 UTC datetime. Otherwise null. " +
        "Never set due on a note, idea, link, or quote. " +
        "A date that is narrative — a letter date, 'generated on', an appointment log, a month in parentheses, " +
        "or anything already in the past — is not a due date. " +
        "priority: true only for urgency markers in the text you were given (urgent, asap, '!!', a hard deadline today).",
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

/* Regex fallback — mirrors the dashboard's client-side parser.
   A relative reminder ("tomorrow", "next friday") can make a task.
   A bare weekday or a calendar date does not, and only tasks keep a due. */
const RE_URL = /(https?:\/\/[^\s<]+)/i;
const RE_TASK = /\b(todo|to-do|remind me|need(s)? to|don'?t forget|must|buy|get|pick up|call|phone|email|text|message|pay|book|schedule|renew|cancel|return|order|fix|repair|clean|finish|submit|file|sign up|register|deadline|due|appointment|rsvp)\b/i;
const RE_IDEA = /^(idea|concept)[:\s]|\b(what if|imagine|app (for|that|idea)|startup|business idea|feature idea|side project)\b/i;
const RE_QUOTE = /^\s*["“].+["”]\s*([—–-].+)?$/s;
const RE_PRI = /(!{2,}|\burgent(ly)?\b|\basap\b|\bimportant\b|\bcritical\b)/i;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

function regexClassify(text) {
  const tags = [...text.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase());
  const when = parseWhen(text);
  let type;
  if (RE_QUOTE.test(text)) type = "quote";
  else if (RE_URL.test(text) && text.replace(RE_URL, "").trim().length < 60) type = "link";
  else if (RE_TASK.test(text) || (when && when.kind === "relative" && !RE_IDEA.test(text))) type = "task";
  else if (RE_IDEA.test(text)) type = "idea";
  else if (RE_URL.test(text)) type = "link";
  else type = "note";
  return { type, tags, due: type === "task" && when ? when.due : null, priority: RE_PRI.test(text) };
}

function parseWhen(text) {
  const now = new Date();
  const lower = text.toLowerCase();
  let d = null;
  let kind = null;
  const mark = (date, k) => { d = date; kind = k; };
  const at = (date, h, m) => { const x = new Date(date); x.setUTCHours(h, m || 0, 0, 0); return x; };
  const monthIndex = (token) => MONTHS.findIndex((mm) => mm.startsWith(String(token).replace(".", "").slice(0, 3)));

  let m;
  if ((m = lower.match(/\bin (\d+) (minute|min|hour|hr|day|week)s?\b/))) {
    const n = +m[1];
    const x = new Date(now);
    if (/min/.test(m[2])) x.setMinutes(x.getMinutes() + n);
    else if (/h/.test(m[2])) x.setHours(x.getHours() + n);
    else if (m[2] === "day") x.setDate(x.getDate() + n);
    else x.setDate(x.getDate() + 7 * n);
    mark(x, "relative");
  } else if (/\btomorrow\b/.test(lower)) {
    const x = new Date(now); x.setUTCDate(x.getUTCDate() + 1); mark(at(x, 9), "relative");
  } else if (/\btonight\b/.test(lower)) {
    mark(at(now, 20), "relative");
  } else if (/\btoday\b/.test(lower)) {
    mark(at(now, 18), "relative");
  } else if (/\bnext week\b/.test(lower)) {
    const x = new Date(now); x.setUTCDate(x.getUTCDate() + 7); mark(at(x, 9), "relative");
  } else if ((m = lower.match(/\b(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const target = DAYS.indexOf(m[2]);
    let delta = (target - now.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    const x = new Date(now); x.setUTCDate(x.getUTCDate() + delta);
    mark(at(x, 9), m[1] ? "relative" : "weekday");
  } else if ((m = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\.?(?:,?\\s*((?:19|20)\\d{2}))?\\b`)))) {
    const year = m[3] ? +m[3] : now.getUTCFullYear();
    const x = new Date(Date.UTC(year, monthIndex(m[2]), +m[1], 9));
    if (!m[3] && x < now) x.setUTCFullYear(x.getUTCFullYear() + 1);
    mark(x, "absolute");
  } else if ((m = lower.match(new RegExp(`\\b(${MONTH})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*((?:19|20)\\d{2}))?\\b`)))) {
    const year = m[3] ? +m[3] : now.getUTCFullYear();
    const x = new Date(Date.UTC(year, monthIndex(m[1]), +m[2], 9));
    if (!m[3] && x < now) x.setUTCFullYear(x.getUTCFullYear() + 1);
    mark(x, "absolute");
  }

  if ((m = lower.match(/\b(?:at|by|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)) && (m[3] || m[2])) {
    let h = +m[1];
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    const x = at(d || now, h, m[2] ? +m[2] : 0);
    if (!d && x < now) x.setUTCDate(x.getUTCDate() + 1);
    d = x;
    if (!kind) kind = "relative";
  }
  return d ? { due: d.getTime(), kind } : null;
}

/* Needs attention — keep in sync with logic.js.
   Overdue tasks stay up for a week. Urgent drops stay relevant for two
   weeks. Notes, ideas, links, and quotes are never overdue. */
const OVERDUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const URGENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function isSameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
function isHiddenFromAttention(d, now) {
  if (!d || d.done) return true;
  if (d.attentionDismissed) return true;
  if (d.attentionUntil && d.attentionUntil > now) return true;
  return false;
}
function isSnoozeWoken(d, now) {
  return !!(d && d.attentionSnoozed && d.attentionUntil && d.attentionUntil <= now && !d.done && !d.attentionDismissed);
}
function isTaskDueToday(d, now) {
  return !!(d && d.type === "task" && d.due && !d.done && isSameDay(d.due, now));
}
function isRecentlyOverdue(d, now) {
  if (!d || d.type !== "task" || !d.due || d.done) return false;
  if (isSameDay(d.due, now)) return false;
  if (d.due >= now) return false;
  return now - d.due <= OVERDUE_WINDOW_MS;
}
function isUrgentRelevant(d, now) {
  if (!d || !d.priority || d.done) return false;
  if (d.created && now - d.created <= URGENT_WINDOW_MS) return true;
  if (d.due && isSameDay(d.due, now)) return true;
  if (d.due && d.due < now && now - d.due <= URGENT_WINDOW_MS) return true;
  return false;
}
function needsAttention(d, now = Date.now()) {
  if (isHiddenFromAttention(d, now)) return false;
  if (isSnoozeWoken(d, now)) return true;
  if (isTaskDueToday(d, now)) return true;
  if (isRecentlyOverdue(d, now)) return true;
  if (d.priority && isUrgentRelevant(d, now)) return true;
  return false;
}
function isStaleAttention(d, now = Date.now()) {
  if (isHiddenFromAttention(d, now)) return false;
  if (needsAttention(d, now)) return false;
  if (!d.due || d.due >= now) return false;
  if (isSameDay(d.due, now)) return false;
  return true;
}
function attentionSort(a, b, now) {
  const rank = (d) => {
    if (isTaskDueToday(d, now)) return 0;
    if (d.priority && isUrgentRelevant(d, now)) return 1;
    if (isRecentlyOverdue(d, now)) return 2;
    return 3;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const urgentDelta = Number(!!b.priority) - Number(!!a.priority);
    if (urgentDelta) return urgentDelta;
    return a.due - b.due;
  }
  if (ra === 1) return (b.created || 0) - (a.created || 0);
  if (ra === 2) return b.due - a.due;
  return (b.attentionUntil || 0) - (a.attentionUntil || 0);
}
function partitionBoard(drops, now = Date.now()) {
  const attention = [];
  const stale = [];
  const rest = [];
  for (const d of drops) {
    if (needsAttention(d, now)) attention.push(d);
    else if (isStaleAttention(d, now)) stale.push(d);
    else rest.push(d);
  }
  attention.sort((a, b) => attentionSort(a, b, now));
  stale.sort((a, b) => (b.due || 0) - (a.due || 0));
  return { attention, stale, rest };
}

export { sanitizeCapturedEmail, regexClassify, partitionBoard, needsAttention, isStaleAttention, splitEmailContent };
