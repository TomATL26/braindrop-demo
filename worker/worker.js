/**
 * Braindrop backend — a single-file Cloudflare Worker.
 *
 * Routes:
 *   POST  /telegram          Telegram bot webhook (secret-token verified)
 *   POST  /email?token=...   Inbound-email webhook (Postmark/Mailgun/SendGrid)
 *   GET   /api/sync          {drops, tombstones}       (Bearer DASH_TOKEN)
 *   GET   /api/drops         List all drops            (Bearer DASH_TOKEN)
 *   POST  /api/drops         Add a drop  {text, id?}   (Bearer DASH_TOKEN)
 *   POST  /api/drops/import  Upsert drops + tombstones (Bearer DASH_TOKEN)
 *   PATCH /api/drops/:id     Update done, text, snooze, dismiss, link preview
 *   DELETE /api/drops/:id    Delete (tombstoned)       (Bearer DASH_TOKEN)
 *   GET   /api/unfurl?url=   Fetch a page title + description (Bearer DASH_TOKEN)
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
const TOMB_KEY = "tombstones";
const MAX_DROPS = 2000;
const MAX_TOMBS = 5000;

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
      if (url.pathname === "/api/unfurl" && request.method === "GET") return unfurlRoute(request, env, url);
      if (url.pathname === "/api/sync" && request.method === "GET") return syncState(request, env);
      if (url.pathname === "/api/drops/import" && request.method === "POST") return importDrops(request, env);
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
async function loadTombs(env) {
  return (await env.DROPS.get(TOMB_KEY, "json")) || [];
}
async function saveTombs(env, tombs) {
  await env.DROPS.put(TOMB_KEY, JSON.stringify(tombs.slice(-MAX_TOMBS)));
}

const DROP_TYPES = new Set(["task", "idea", "note", "link", "quote"]);
const DROP_SOURCES = new Set(["web", "telegram", "email"]);

/** Keep a client drop's identity, archive flag, and link preview. Reject junk. */
export function sanitizeDrop(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || !text) return null;
  const drop = {
    id,
    text: text.slice(0, 20000),
    type: DROP_TYPES.has(raw.type) ? raw.type : "note",
    tags: Array.isArray(raw.tags)
      ? raw.tags.slice(0, 24).map((t) => String(t).toLowerCase().replace(/^#/, "").slice(0, 40)).filter(Boolean)
      : [],
    due: typeof raw.due === "number" && Number.isFinite(raw.due) ? raw.due : null,
    priority: !!raw.priority,
    done: !!raw.done,
    created: typeof raw.created === "number" && raw.created > 0 ? raw.created : now,
    source: DROP_SOURCES.has(raw.source) ? raw.source : "web",
    notified: !!raw.notified,
    updated: typeof raw.updated === "number" && raw.updated > 0 ? raw.updated : now,
  };
  if (typeof raw.body === "string" && raw.body.trim()) drop.body = raw.body.slice(0, 20000);
  if (typeof raw.emailFrom === "string" && raw.emailFrom.trim()) drop.emailFrom = raw.emailFrom.slice(0, 240);
  if (typeof raw.title === "string" && raw.title.trim()) drop.title = raw.title.slice(0, 200);
  if (typeof raw.dueLabel === "string" && raw.dueLabel.trim()) drop.dueLabel = raw.dueLabel.slice(0, 80);
  if (typeof raw.linkTitle === "string" && raw.linkTitle.trim()) drop.linkTitle = raw.linkTitle.slice(0, 180);
  if (typeof raw.linkDescription === "string" && raw.linkDescription.trim()) drop.linkDescription = raw.linkDescription.slice(0, 280);
  if (typeof raw.linkDomain === "string" && raw.linkDomain.trim()) drop.linkDomain = raw.linkDomain.slice(0, 120);
  if (raw.linkTitleSource === "fetched" || raw.linkTitleSource === "heuristic") drop.linkTitleSource = raw.linkTitleSource;
  if (typeof raw.snoozedUntil === "number") drop.snoozedUntil = raw.snoozedUntil;
  if (raw.attentionDismissed) drop.attentionDismissed = true;
  if (drop.done && typeof raw.doneAt === "number") drop.doneAt = raw.doneAt;
  return drop;
}

/**
 * Merge an upload into the shared store.
 * Inserts missing drops, keeps the newer copy when both sides have an id,
 * and never deletes a drop unless its id is tombstoned.
 */
export function applyImport(drops, tombs, incomingDrops, incomingTombIds, now = Date.now()) {
  const tombList = Array.isArray(tombs) ? tombs.filter((t) => t && typeof t.id === "string") : [];
  const dead = new Set(tombList.map((t) => t.id));
  for (const id of incomingTombIds || []) {
    if (typeof id !== "string") continue;
    const clean = id.trim().slice(0, 80);
    if (!clean || dead.has(clean)) continue;
    tombList.push({ id: clean, at: now });
    dead.add(clean);
  }
  const kept = (Array.isArray(drops) ? drops : []).filter((d) => d && d.id && !dead.has(d.id));
  for (const raw of incomingDrops || []) {
    const drop = sanitizeDrop(raw, now);
    if (!drop || dead.has(drop.id)) continue;
    const idx = kept.findIndex((d) => d.id === drop.id);
    if (idx < 0) kept.unshift(drop);
    else if ((drop.updated || 0) >= (kept[idx].updated || 0)) kept[idx] = { ...kept[idx], ...drop };
  }
  kept.sort((a, b) => (b.created || 0) - (a.created || 0));
  return { drops: kept.slice(0, MAX_DROPS), tombstones: tombList.slice(-MAX_TOMBS) };
}

function authorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return !!(env.DASH_TOKEN && auth === `Bearer ${env.DASH_TOKEN}`);
}

async function syncState(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  return json({ drops: await loadDrops(env), tombstones: await loadTombs(env) });
}

async function importDrops(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  const incoming = Array.isArray(body.drops) ? body.drops.slice(0, 500) : [];
  const tombsIn = Array.isArray(body.tombstones) ? body.tombstones.slice(0, 500) : [];
  const result = applyImport(await loadDrops(env), await loadTombs(env), incoming, tombsIn);
  await saveDrops(env, result.drops);
  await saveTombs(env, result.tombstones);
  return json(result);
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
    const payload = await request.json();
    const text = payload && payload.text;
    if (!text || !String(text).trim()) return json({ error: "text required" }, 400);
    const drop = await classify(String(text).trim(), env, "web");
    if (typeof payload.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(payload.id) && !drops.some((d) => d.id === payload.id)) {
      drop.id = payload.id;
    }
    drops.unshift(drop);
    await saveDrops(env, drops);
    return json(drop, 201);
  }

  const idx = drops.findIndex((d) => d.id === id);
  if (idx < 0) return json({ error: "not found" }, 404);

  if (request.method === "PATCH") {
    const patch = await request.json();
    if (typeof patch.done === "boolean") {
      drops[idx].done = patch.done;
      if (patch.done) drops[idx].doneAt = typeof patch.doneAt === "number" ? patch.doneAt : (drops[idx].doneAt || Date.now());
      else delete drops[idx].doneAt;
    }
    if (patch.snoozedUntil === null) delete drops[idx].snoozedUntil;
    else if (typeof patch.snoozedUntil === "number") drops[idx].snoozedUntil = patch.snoozedUntil;
    if (typeof patch.attentionDismissed === "boolean") drops[idx].attentionDismissed = patch.attentionDismissed;
    if (typeof patch.linkTitle === "string") drops[idx].linkTitle = patch.linkTitle.slice(0, 180);
    if (typeof patch.linkDescription === "string") drops[idx].linkDescription = patch.linkDescription.slice(0, 280);
    if (typeof patch.linkDomain === "string") drops[idx].linkDomain = patch.linkDomain.slice(0, 120);
    if (patch.linkTitleSource === "fetched" || patch.linkTitleSource === "heuristic") drops[idx].linkTitleSource = patch.linkTitleSource;
    if (typeof patch.title === "string") drops[idx].title = patch.title.slice(0, 200);
    drops[idx].updated = typeof patch.updated === "number" ? patch.updated : Date.now();
    if (typeof patch.text === "string" && patch.text.trim()) {
      const prev = drops[idx];
      const re = await classify(patch.text.trim(), env, prev.source);
      drops[idx] = {
        ...re,
        id: prev.id,
        created: prev.created,
        updated: prev.updated,
        done: prev.done,
        doneAt: prev.doneAt,
        body: prev.body,
        emailFrom: prev.emailFrom,
        snoozedUntil: prev.snoozedUntil,
        attentionDismissed: false,
        source: prev.source,
      };
    }
    await saveDrops(env, drops);
    return json(drops[idx]);
  }

  if (request.method === "DELETE") {
    const result = applyImport(drops, await loadTombs(env), [], [id]);
    await saveDrops(env, result.drops);
    await saveTombs(env, result.tombstones);
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
      .filter((d) => needsAttention(d, now))
      .sort((a, b) => (a.due || Infinity) - (b.due || Infinity));
    await reply(env, msg.chat.id, attention.length
      ? "⚠ Needs attention:\n" + attention.map((d) => `• ${briefLabel(d)}`).join("\n")
      : "Nothing due today or newly overdue. 🎉");
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
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    // The drop is already stored. A failed reply must not make Telegram retry
    // the webhook and file a second copy.
    console.log("telegram reply failed:", e.message);
  }
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
  const cleanBody = cleanEmailNoise(extractEmailContent(body || ""));
  if (!cleanSubject && !cleanBody) return null;

  // Classify on subject + a slice of body, but keep them separate for display:
  // the subject is the card title, the body is the expandable context section.
  // Dates that only appear in the forwarded body are not deadlines — they used
  // to pin months-old mail in Needs attention forever.
  const drop = await classify(
    [cleanSubject, cleanBody.slice(0, 1500)].filter(Boolean).join("\n"), env, "email");
  const firstLine = cleanBody.split("\n").find((line) => line.trim()) || "";
  drop.text = cleanSubject || firstLine.slice(0, 140);
  drop.body = cleanBody || undefined;
  drop.emailFrom = from || undefined;
  const title = shortTitle(drop.text);
  if (title && title !== drop.text) drop.title = title;
  if (drop.type !== "task") drop.due = null;
  else drop.due = subjectDeadline(cleanSubject);
  if (!RE_PRI.test(cleanSubject || "")) drop.priority = false;
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
function extractEmailContent(body) {
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
  return [note, forwarded].filter(Boolean).join("\n\n")
    .replace(/^>.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
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
  // A date inside a note, idea, link, or quote is context, not a deadline.
  if (result.type !== "task") result.due = null;

  return {
    id: crypto.randomUUID().slice(0, 12),
    text,
    type: result.type,
    tags: result.tags,
    due: result.due,
    priority: result.priority,
    done: false,
    created: Date.now(),
    updated: Date.now(),
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
        "due: only for tasks, and only when the user's own words commit to a time. " +
        "Dates inside forwarded emails, newsletters, receipts, and past events are not deadlines — use null. " +
        "Never set due on notes, ideas, links, or quotes. Resolve a real deadline in the user's timezone " +
        "(honor an explicit timezone if the text names one; default to 09:00 local when no time is given) " +
        "and output it as an ISO 8601 UTC datetime; else null. " +
        "priority: true only when the user's own words are urgent (urgent, asap, '!!', a hard deadline today), " +
        "not when a forwarded thread mentions urgency about something already past.",
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

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function monthIndex(token) {
  const s = String(token || "").toLowerCase().replace(".", "").slice(0, 3);
  return MONTHS.findIndex((mm) => mm.startsWith(s));
}

function parseWhen(text, nowMs = Date.now()) {
  const now = new Date(nowMs);
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
  } else if ((m = lower.match(new RegExp("\\b" + MON + "\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b")))) {
    const mi = monthIndex(m[1]);
    const x = new Date(Date.UTC(now.getUTCFullYear(), mi, +m[2], 15, 0, 0));
    if (x < now) x.setUTCFullYear(x.getUTCFullYear() + 1);
    d = x;
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

/* Attention + email cleaning. Dashboard copy lives in braindrop-logic.js. */
const ATTENTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function isDueToday(d, now) {
  if (!d || d.type !== "task" || !d.due || d.done) return false;
  return new Date(d.due).toDateString() === new Date(now).toDateString();
}

function needsAttention(d, now = Date.now()) {
  if (!d || d.done || d.attentionDismissed) return false;
  if (d.snoozedUntil && d.snoozedUntil > now) return false;
  if (d.type !== "task") {
    return !!(d.priority && !d.due && now - (d.created || 0) <= ATTENTION_WINDOW_MS);
  }
  if (isDueToday(d, now)) return true;
  if (d.due && d.due < now && now - d.due <= ATTENTION_WINDOW_MS) return true;
  if (d.priority && d.due && Math.abs(d.due - now) <= ATTENTION_WINDOW_MS) return true;
  if (d.priority && !d.due && now - (d.created || 0) <= ATTENTION_WINDOW_MS) return true;
  return false;
}

function briefLabel(d) {
  if (d.title && !/^https?:\/\//i.test(d.title)) return String(d.title).split("\n")[0].slice(0, 140);
  if (d.linkTitle && !/^https?:\/\//i.test(d.linkTitle)) return String(d.linkTitle).slice(0, 140);
  const line = String(d.text || "").split("\n")[0].trim();
  if (/^https?:\/\//i.test(line)) {
    try { return new URL(line.split(/\s/)[0]).hostname.replace(/^www\./, ""); }
    catch { /* keep the line */ }
  }
  return line.slice(0, 140);
}

function shortTitle(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, "");
  t = t.replace(
    /^(addendum|update|reminder)\s+\d{1,2}\s+[A-Za-z]{3,12}\s+\d{2,4}\s*[—–\-|:]+\s*/i,
    (_, w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() + " — "
  );
  t = t.replace(/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{4}\b/gi, " ");
  t = t.replace(/\s*[—–]{1,}\s*/g, " — ");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+—\s*$/g, "").replace(/^[\s—–\-|:]+/, "").trim();
  if (t.length > 92) {
    const cut = t.slice(0, 92);
    const pivot = Math.max(cut.lastIndexOf(" — "), cut.lastIndexOf("; "), cut.lastIndexOf(", "), cut.lastIndexOf(" "));
    t = (pivot > 36 ? cut.slice(0, pivot) : cut).trim().replace(/[,\s—–\-|:]+$/g, "") + "…";
  }
  return t;
}

function isImageFilename(t) {
  const name = t.replace(/^<|>$/g, "");
  if (!/\.(png|jpe?g|gif|webp|heic)$/i.test(name)) return false;
  return /\d{5,}/.test(name) || name.length > 40;
}

function cleanEmailNoise(body) {
  if (!body) return "";
  const lines = String(body).replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^sent from my (iphone|ipad|ipod|mobile)/i.test(t)) continue;
    if (/^sent from mail(\s+for\s+windows)?$/i.test(t)) continue;
    if (/^get outlook for (ios|android|mac)$/i.test(t)) continue;
    if (/^\[image:?\s*.*\]$/i.test(t)) continue;
    if (/^\[cid:.*\]$/i.test(t)) continue;
    if (isImageFilename(t)) continue;
    if (/^-{2,}\s*forwarded message\s*-{2,}$/i.test(t)) continue;
    if (/^begin forwarded message:?$/i.test(t)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildUtcDate(day, month, year, nowMs) {
  if (month < 0 || day < 1 || day > 31) return null;
  const y = year || new Date(nowMs).getUTCFullYear();
  const x = new Date(Date.UTC(y, month, day, 15, 0, 0));
  if (x.getUTCMonth() !== month || x.getUTCDate() !== day) return null;
  return x.getTime();
}

/** Absolute date in a subject, with no year-rollover. Historical mail stays in the past. */
function parseAbsoluteDate(text, nowMs = Date.now()) {
  const lower = String(text || "").toLowerCase();
  let m;
  if ((m = lower.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+" + MON + "(?:\\.?\\s+(\\d{4}))?\\b")))) {
    return buildUtcDate(+m[1], monthIndex(m[2]), m[3] ? +m[3] : null, nowMs);
  }
  if ((m = lower.match(new RegExp("\\b" + MON + "\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b")))) {
    return buildUtcDate(+m[2], monthIndex(m[1]), m[3] ? +m[3] : null, nowMs);
  }
  return null;
}

function subjectDeadline(subject, nowMs = Date.now()) {
  if (!subject) return null;
  const abs = parseAbsoluteDate(subject, nowMs);
  if (abs) return abs < nowMs - ATTENTION_WINDOW_MS ? null : abs;
  const rel = parseWhen(subject, nowMs);
  if (!rel) return null;
  if (rel < nowMs - ATTENTION_WINDOW_MS) return null;
  return rel;
}

function isPublicHttpUrl(str) {
  let u;
  try { u = new URL(str); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0" || h === "::1") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(h)) return false;
  if (/^\d+$/.test(h)) return false;
  return true;
}

function isJunkTitle(title) {
  const t = String(title || "").trim().toLowerCase();
  if (!t || t.length < 3) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^(log\s?in|login|sign\s?up|signup|facebook|instagram|apple news|twitter|just a moment|attention required|access denied|forbidden|error|403|404|page not found|redirecting|cookie policy)$/.test(t)) return true;
  if (t.length < 48 && /\b(log\s?in|sign\s?in|sign\s?up)\b/.test(t)) return true;
  return false;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, " ");
}

function unfurlFromHtml(html, targetUrl) {
  const src = String(html || "");
  const pick = (prop) => {
    const a = new RegExp("<meta[^>]+(?:property|name)=[\"']" + prop + "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>", "i");
    const b = new RegExp("<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" + prop + "[\"'][^>]*>", "i");
    const m = src.match(a) || src.match(b);
    return m ? decodeEntities(m[1]) : "";
  };
  let title = pick("og:title") || pick("twitter:title");
  if (!title) {
    const m = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) title = decodeEntities(m[1]);
  }
  let description = pick("og:description") || pick("twitter:description") || pick("description");
  title = title.replace(/\s+/g, " ").trim().slice(0, 180);
  description = description.replace(/\s+/g, " ").trim().slice(0, 280);
  let domain = "";
  try { domain = new URL(targetUrl).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  if (isJunkTitle(title)) return { title: "", description: "", domain };
  return { title, description, domain };
}

async function unfurlRoute(request, env, url) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.DASH_TOKEN || auth !== `Bearer ${env.DASH_TOKEN}`) return json({ error: "unauthorized" }, 401);
  const target = url.searchParams.get("url") || "";
  if (!isPublicHttpUrl(target)) return json({ error: "bad url" }, 400);
  let domain = "";
  try { domain = new URL(target).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  try {
    const res = await fetch(target, {
      redirect: "follow",
      headers: { "User-Agent": "BraindropUnfurl/1.0", "Accept": "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(6000),
    });
    if (res.url && !isPublicHttpUrl(res.url)) return json({ title: "", description: "", domain });
    const ctype = res.headers.get("content-type") || "";
    if (!res.ok || !/text\/html|application\/xhtml/i.test(ctype)) return json({ title: "", description: "", domain });
    const html = (await res.text()).slice(0, 250000);
    return json(unfurlFromHtml(html, target));
  } catch {
    return json({ title: "", description: "", domain });
  }
}

export {
  needsAttention,
  subjectDeadline,
  cleanEmailNoise,
  shortTitle,
  unfurlFromHtml,
  isPublicHttpUrl,
  briefLabel,
  parseWhen,
};
