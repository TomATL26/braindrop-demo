/**
 * Braindrop backend — a single-file Cloudflare Worker.
 *
 * Routes:
 *   POST  /telegram          Telegram bot webhook (secret-token verified)
 *   POST  /email?token=...   Inbound-email webhook (Postmark/Mailgun/SendGrid)
 *   GET   /api/drops         List all drops            (Bearer DASH_TOKEN)
 *   POST  /api/drops         Add a drop  {text}        (Bearer DASH_TOKEN)
 *   PATCH /api/drops/:id     Update {done|text|attentionDismissed|snoozeUntil} (Bearer DASH_TOKEN)
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
    if (patch.snoozeUntil === null) drops[idx].snoozeUntil = null;
    else if (typeof patch.snoozeUntil === "number" && Number.isFinite(patch.snoozeUntil)) drops[idx].snoozeUntil = patch.snoozeUntil;
    if (typeof patch.text === "string" && patch.text.trim()) {
      const prev = drops[idx];
      const re = await classify(patch.text.trim(), env, prev.source);
      drops[idx] = {
        ...prev,
        ...re,
        id: prev.id,
        created: prev.created,
        done: prev.done,
        body: prev.body,
        emailFrom: prev.emailFrom,
        source: prev.source,
        // A rewrite is a fresh look at the drop, so it can surface again.
        attentionDismissed: false,
        snoozeUntil: null,
        notified: false,
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
    const attention = drops.filter((d) => needsAttention(d, now)).sort((a, b) => compareAttention(a, b, now));
    await reply(env, msg.chat.id, attention.length
      ? "⚠ Needs attention:\n" + attention.map((d) => `• ${listLabel(d)}`).join("\n")
      : "Nothing due today, recently overdue, or still urgent. 🎉");
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
  const parts = splitEmail(body || "");
  const cleanBody = parts.combined;
  if (!cleanSubject && !parts.note && !cleanBody) return null;

  // The subject and any note typed above the forward decide the deadline.
  // The forwarded body is context for type and tags only — a date inside an
  // old thread must not become a due date that never ages out.
  const intent = [parts.note, cleanSubject].filter(Boolean).join("\n").trim()
    || (cleanBody.split("\n")[0] || "").slice(0, 180);
  const classifyInput = parts.forwarded
    ? `${intent}\n\n----- forwarded content (context only) -----\n${parts.forwarded.slice(0, 1500)}`
    : intent;

  const drop = await classify(classifyInput, env, "email");
  drop.text = cleanSubject || parts.note || cleanBody.split("\n")[0].slice(0, 120);
  drop.body = cleanBody || undefined;
  drop.emailFrom = from || undefined;
  const drops = await loadDrops(env);
  drops.unshift(drop);
  await saveDrops(env, drops);
  return drop;
}

/**
 * Pull the readable content out of an email body. For forwards, the content
 * lives *inside* the "---------- Forwarded message ----------" block, after
 * its From/Date/Subject/To header lines; any note the sender typed above the
 * marker is kept too.
 */
function splitEmail(body) {
  const normalized = String(body || "").replace(/\r\n/g, "\n");
  const parts = normalized.split(/^-{2,}\s*Forwarded message\s*-{2,}\s*$/im);
  const note = (parts[0] || "").trim();
  let forwarded = parts.slice(1).join("\n").trim();
  if (forwarded) {
    const lines = forwarded.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i].trim() === "" || /^\s*(from|date|sent|subject|to|cc)\s*:/i.test(lines[i]))) i++;
    forwarded = lines.slice(i).join("\n").trim();
  }
  const clean = (s) => s.replace(/^>.*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  const noteC = clean(note);
  const fwdC = clean(forwarded);
  return {
    note: noteC.slice(0, 1000),
    forwarded: fwdC.slice(0, 4000),
    combined: [noteC, fwdC].filter(Boolean).join("\n\n").slice(0, 4000),
  };
}

function extractEmailContent(body) {
  return splitEmail(body).combined;
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
  if (source === "email") result = applyEmailGuards(result, text);

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
        "due: if the subject or the forwarder's own note implies a deadline or reminder, resolve it in the user's timezone " +
        "(honor an explicit timezone if the text names one; default to 09:00 local when no time is given) " +
        "and output it as an ISO 8601 UTC datetime; else null. " +
        "A document stamp in a subject (for example '25 Jul 2026 --') is not a deadline. " +
        "Notes, ideas, links, and quotes get due null. " +
        "If the message contains a line '----- forwarded content (context only) -----', " +
        "everything after it is forwarded context: use it for type and tags only. " +
        "Never take a due date, a reminder, urgency, or 'this is a task' from that section. " +
        "If the text starts with task:, idea:, note:, link:, or quote:, that prefix forces the type. " +
        "priority: true only for urgency markers in the subject or the forwarder's note (urgent, asap, '!!').",
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
const RE_OVERRIDE = /^(task|idea|note|link|quote)\s*:\s*/i;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function intentText(text) {
  let raw = String(text || "").replace(/\r\n/g, "\n");
  raw = raw.split(/\n?-{2,}\s*forwarded message\b/i)[0];
  raw = raw.split(/\n?-{5}\s*forwarded content\b/i)[0];
  return (raw.split(/\n\s*\n/)[0] || "").trim().slice(0, 300);
}

function regexClassify(text, now = new Date()) {
  let raw = String(text || "");
  let type = null;
  const ov = raw.match(RE_OVERRIDE);
  if (ov) { type = ov[1].toLowerCase(); raw = raw.slice(ov[0].length).trim() || raw; }
  const intent = intentText(raw);
  const tags = [...String(text || "").matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase());
  const due = parseWhen(intent, now);
  const priority = RE_PRI.test(intent);
  const rest = intent.replace(/https?:\/\/[^\s<]+/gi, " ").replace(/#[\p{L}\p{N}_-]+/gu, " ").trim();
  if (!type) {
    if (RE_QUOTE.test(intent) && intent.length < 500) type = "quote";
    else if (RE_URL.test(intent) && rest.length < 60) type = "link";
    else if (RE_TASK.test(intent) || (due && !RE_IDEA.test(intent))) type = "task";
    else if (RE_IDEA.test(intent)) type = "idea";
    else type = "note";
  }
  return { type, tags: [...new Set(tags)], due, priority };
}

// For email, deadlines and urgency come from the subject / forwarder note.
// Claude may still choose type and tags from the forwarded body (a recipe, a topic).
function applyEmailGuards(result, text, now = new Date()) {
  const local = regexClassify(intentText(text), now);
  const guarded = { ...result, tags: [...(result.tags || [])] };
  guarded.due = local.due;
  guarded.priority = local.priority;
  const ov = intentText(text).match(RE_OVERRIDE);
  if (ov) guarded.type = ov[1].toLowerCase();
  else if (local.type === "task") guarded.type = "task";
  else if (guarded.type === "task") guarded.type = local.type;
  const tags = [...String(text || "").matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase());
  guarded.tags = [...new Set([...(guarded.tags || []).map((t) => String(t).toLowerCase().replace(/^#/, "")), ...tags])];
  return guarded;
}

function parseWhen(text, now = new Date()) {
  const lower = String(text || "").toLowerCase();
  let d = null;
  const at = (date, h, m) => { const x = new Date(date); x.setUTCHours(h, m || 0, 0, 0); return x; };

  let m;
  if ((m = lower.match(/\bin (\d+) (minute|min|hour|hr|day|week)s?\b/))) {
    const n = +m[1];
    const x = new Date(now);
    if (/min/.test(m[2])) x.setUTCMinutes(x.getUTCMinutes() + n);
    else if (/h/.test(m[2])) x.setUTCHours(x.getUTCHours() + n);
    else if (m[2] === "day") x.setUTCDate(x.getUTCDate() + n);
    else x.setUTCDate(x.getUTCDate() + 7 * n);
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
  } else if ((m = lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:(?:,\s*|\s+)(\d{4}))?\b/))) {
    const mi = MONTHS.findIndex((mm) => mm.startsWith(m[1].replace(".", "").slice(0, 3)));
    const year = m[3] ? +m[3] : now.getUTCFullYear();
    const x = new Date(Date.UTC(year, mi, +m[2], 9, 0, 0, 0));
    if (m[3] && x.getTime() < now.getTime() - 36 * 3600e3) { /* historical document date */ }
    else {
      if (!m[3] && x < now) x.setUTCFullYear(x.getUTCFullYear() + 1);
      d = x;
    }
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

/* Needs attention — keep the windows in sync with the dashboard. */
const DAY_MS = 24 * 60 * 60 * 1000;
const OVERDUE_WINDOW_MS = 7 * DAY_MS;
const URGENT_WINDOW_MS = 14 * DAY_MS;

function dueMsOf(d) {
  if (!d || d.due == null || d.due === "") return null;
  const n = typeof d.due === "number" ? d.due : Date.parse(d.due);
  return Number.isFinite(n) ? n : null;
}
function actionableDue(d) {
  if (!d || d.type !== "task") return null;
  const due = dueMsOf(d);
  if (due == null) return null;
  if (d.created && due < d.created - DAY_MS) return null;
  return due;
}
function stillRelevant(d, now) {
  const created = d.created || now;
  if (now - created <= URGENT_WINDOW_MS) return true;
  const due = actionableDue(d);
  if (due == null) return false;
  const delta = due - now;
  return delta >= -OVERDUE_WINDOW_MS && delta <= OVERDUE_WINDOW_MS;
}
function needsAttention(d, now = Date.now()) {
  if (!d || d.done || d.attentionDismissed) return false;
  if (typeof d.snoozeUntil === "number" && d.snoozeUntil > now) return false;
  if (typeof d.snoozeUntil === "number" && d.snoozeUntil <= now && now - d.snoozeUntil <= OVERDUE_WINDOW_MS) return true;
  const due = actionableDue(d);
  if (due != null) {
    if (new Date(due).toDateString() === new Date(now).toDateString()) return true;
    if (due < now && now - due <= OVERDUE_WINDOW_MS) return true;
  }
  if (d.priority && stillRelevant(d, now)) return true;
  return false;
}
function compareAttention(a, b, now = Date.now()) {
  const rank = (d) => {
    const due = actionableDue(d);
    if (due != null && new Date(due).toDateString() === new Date(now).toDateString()) return [0, due];
    if (due != null && due < now && now - due <= OVERDUE_WINDOW_MS) return [1, now - due];
    return [2, now - (d.created || 0)];
  };
  const ra = rank(a), rb = rank(b);
  if (ra[0] !== rb[0]) return ra[0] - rb[0];
  return ra[1] - rb[1];
}
function listLabel(d) {
  const text = String(d.text || "").trim();
  const url = text.match(/https?:\/\/\S+/);
  const rest = text.replace(/https?:\/\/\S+/g, "").replace(/#\S+/g, "").trim();
  if (url && !rest) {
    try { return new URL(url[0].replace(/[),.;]+$/, "")).hostname.replace(/^www\./, ""); }
    catch { return "link"; }
  }
  const line = text.split("\n")[0];
  return line.length > 90 ? line.slice(0, 88).replace(/\s+\S*$/, "") + "…" : line;
}

export { intentText, regexClassify, parseWhen, applyEmailGuards, needsAttention, splitEmail, actionableDue };
