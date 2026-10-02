/* Braindrop board rules.
   Loaded as a classic script (so index.html still opens from disk) and
   attached to globalThis.BraindropLogic. Keep the attention helpers in
   worker/worker.js in sync with this file. */
(function (root) {
  "use strict";

  // A missed task stays on the board for a week. An urgent drop stays relevant
  // for two weeks from when it was captured or came due. After that, a date
  // parsed out of an old email is history: it leaves Needs attention instead
  // of pinning the top of the board. Notes, ideas, links, and quotes are
  // never overdue — a date in the prose is not a deadline.
  const OVERDUE_WINDOW_DAYS = 7;
  const URGENT_WINDOW_DAYS = 14;
  const SNOOZE_DAYS = 7;
  const DAY = 24 * 60 * 60 * 1000;
  const OVERDUE_WINDOW_MS = OVERDUE_WINDOW_DAYS * DAY;
  const URGENT_WINDOW_MS = URGENT_WINDOW_DAYS * DAY;

  const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  const RE_URL = /(https?:\/\/[^\s<]+)/i;
  const RE_TAG = /#([\p{L}\p{N}_-]+)/gu;
  const RE_TASK = /\b(todo|to-do|remind me|need(s)? to|don'?t forget|must|buy|get|pick up|call|phone|email|text|message|pay|book|schedule|renew|cancel|return|order|fix|repair|clean|finish|submit|file|sign up|register|deadline|due|appointment|rsvp|water|feed|take out)\b/i;
  const RE_IDEA = /^(idea|concept)[:\s]|\b(what if|imagine|app (for|that|idea)|startup|business idea|feature idea|could (we|i) (build|make)|side project)\b/i;
  const RE_QUOTE = /^\s*["“].+["”]\s*([—–-].+)?$/s;
  const RE_PRI = /(!{2,}|\burgent(ly)?\b|\basap\b|\bimportant\b|\bcritical\b)/i;
  const RE_OVERRIDE = /^(task|idea|note|link|quote)\s*:\s*/i;

  const DATE_TOKEN = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH})\\.?(?:,?\\s*(?:19|20)\\d{2})?|(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*(?:19|20)\\d{2})?|(?:${MONTH})\\.?\\s*/\\s*(?:${MONTH})\\.?\\s*(?:19|20)\\d{2}|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?)`;

  function shortTitle(text) {
    let s = String(text || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    const original = s;
    s = s.replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, "").trim();

    const dateRe = new RegExp(DATE_TOKEN, "ig");
    let strippedLead = false;
    const lead = new RegExp(`^on\\s+${DATE_TOKEN}\\s*,?\\s*`, "i");
    if (lead.test(s)) {
      s = s.replace(lead, "");
      strippedLead = true;
    }

    const parts = s.split(/\s+(?:--|—|–|\|)\s+/).map((p) => p.trim()).filter(Boolean);
    const clean = (p) => p
      .replace(new RegExp(DATE_TOKEN, "ig"), " ")
      .replace(/\(\s*\)/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "")
      .trim();
    const cleaned = parts.map(clean).filter((p) => p && !/^(addendum|fwd|fw|re|update)$/i.test(p));

    let title;
    if (!cleaned.length) title = clean(s) || original;
    else if (cleaned.length === 1) title = cleaned[0];
    else {
      const first = cleaned[0];
      const rest = cleaned.slice(1).join(" — ");
      const joined = `${first} — ${rest}`;
      if (joined.length <= 78) title = joined;
      else if (first.length >= 12 && first.length <= 78) title = first;
      else title = rest.length <= 78 ? rest : first;
    }

    title = title.replace(/\s{2,}/g, " ").trim();
    if (strippedLead && title) title = title.charAt(0).toUpperCase() + title.slice(1);
    if (title.length > 78) {
      const cut = title.slice(0, 78);
      const sp = cut.lastIndexOf(" ");
      title = (sp > 36 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, "") + "…";
    }
    return title || original;
  }

  function isEmailDrop(d) {
    if (!d) return false;
    if (d.source === "email" || d.body) return true;
    const text = d.text || "";
    return /forwarded message/i.test(text) || (/^(from|subject)\s*:/im.test(text) && text.length > 240);
  }

  function displayTitle(d) {
    const text = String((d && d.text) || "").trim();
    if (!text) return "";
    if (!isEmailDrop(d)) return text;
    const first = text.split(/\n/).map((line) => line.trim()).find(Boolean) || text;
    const short = shortTitle(first);
    if (!short) return text;
    if (short.toLowerCase() === first.toLowerCase()) return first;
    return short;
  }

  function emailView(d) {
    const text = String((d && d.text) || "").trim();
    const title = displayTitle(d);
    const email = isEmailDrop(d);
    const extraSubject = email && title !== text ? text : "";
    const body = (d && d.body) || "";
    const collapsed = body || extraSubject;
    const expanded = [extraSubject, body].filter(Boolean).join("\n\n");
    return {
      title,
      collapsed,
      expanded: expanded || collapsed,
      hasMore: !!(collapsed || expanded),
    };
  }

  function monthIndex(token) {
    const key = String(token || "").replace(".", "").slice(0, 3).toLowerCase();
    return MONTHS.findIndex((mm) => mm.startsWith(key));
  }

  function emailSignal(text) {
    const forwarded = /^-{2,}\s*Forwarded message\s*-{2,}/im.test(text);
    const headerish = /^(from|sent|date|subject|to|cc)\s*:/im.test(text) && text.length > 240;
    if (!forwarded && !headerish) return text;
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const content = lines.find((l) => !/^(from|sent|date|subject|to|cc)\s*:/i.test(l) && !/^-{2,}\s*forwarded message\s*-{2,}$/i.test(l));
    return content || text;
  }

  function parseWhen(text) {
    const now = new Date();
    const lower = text.toLowerCase();
    let d = null;
    let matched = null;
    let kind = null;
    const set = (base, label, k) => { d = base; matched = label; kind = k; };
    const at = (date, h, m) => { const x = new Date(date); x.setHours(h, m || 0, 0, 0); return x; };
    const abs = (year, mi, day, label, explicitYear) => {
      const x = new Date(year, mi, day, 9, 0, 0, 0);
      if (!explicitYear && x < now) x.setFullYear(x.getFullYear() + 1);
      set(x, label, "absolute");
    };

    let m;
    if ((m = lower.match(/\bin (\d+) (minute|min|hour|hr|day|week|month)s?\b/))) {
      const n = +m[1];
      const x = new Date(now);
      if (/min/.test(m[2])) x.setMinutes(x.getMinutes() + n);
      else if (/h/.test(m[2])) x.setHours(x.getHours() + n);
      else if (m[2] === "day") x.setDate(x.getDate() + n);
      else if (m[2] === "week") x.setDate(x.getDate() + 7 * n);
      else x.setMonth(x.getMonth() + n);
      set(x, m[0], "relative");
    } else if (lower.includes("day after tomorrow")) {
      const x = new Date(now); x.setDate(x.getDate() + 2); set(at(x, 9), "day after tomorrow", "relative");
    } else if (/\btomorrow\b/.test(lower)) {
      const x = new Date(now); x.setDate(x.getDate() + 1); set(at(x, 9), "tomorrow", "relative");
    } else if (/\btonight\b/.test(lower)) {
      set(at(now, 20), "tonight", "relative");
    } else if (/\btoday\b/.test(lower)) {
      set(at(now, 18), "today", "relative");
    } else if (/\bnext week\b/.test(lower)) {
      const x = new Date(now); x.setDate(x.getDate() + 7); set(at(x, 9), "next week", "relative");
    } else if ((m = lower.match(/\b(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
      const target = DAYS.indexOf(m[2]);
      let delta = (target - now.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      if (m[1]) delta = delta <= 7 ? delta + (delta < 7 ? 7 : 0) : delta;
      const x = new Date(now); x.setDate(x.getDate() + delta);
      set(at(x, 9), m[0], m[1] ? "relative" : "weekday");
    } else if ((m = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\.?(?:,?\\s*((?:19|20)\\d{2}))?\\b`)))) {
      abs(m[3] ? +m[3] : now.getFullYear(), monthIndex(m[2]), +m[1], m[0], !!m[3]);
    } else if ((m = lower.match(new RegExp(`\\b(${MONTH})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*((?:19|20)\\d{2}))?\\b`)))) {
      abs(m[3] ? +m[3] : now.getFullYear(), monthIndex(m[1]), +m[2], m[0], !!m[3]);
    }

    if ((m = lower.match(/\b(?:at|by|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)) && (m[3] || m[2])) {
      let h = +m[1];
      if (m[3] === "pm" && h < 12) h += 12;
      if (m[3] === "am" && h === 12) h = 0;
      const base = d || now;
      const x = at(base, h, m[2] ? +m[2] : 0);
      if (!d && x < now) x.setDate(x.getDate() + 1);
      d = x;
      matched = (matched ? matched + " " : "") + m[0];
      if (!kind) kind = "relative";
    }
    return d ? { due: d.getTime(), matched, kind } : null;
  }

  function classify(raw) {
    let text = String(raw || "").trim();
    let type = null;
    const ov = text.match(RE_OVERRIDE);
    if (ov) { type = ov[1].toLowerCase(); text = text.slice(ov[0].length).trim() || text; }

    const basis = emailSignal(text);
    const tags = [...text.matchAll(RE_TAG)].map((m) => m[1].toLowerCase());
    const when = parseWhen(basis);
    const priority = RE_PRI.test(basis);

    if (!type) {
      if (RE_QUOTE.test(basis)) type = "quote";
      else if (RE_URL.test(basis) && basis.replace(RE_URL, "").trim().length < 60) type = "link";
      else if (RE_TASK.test(basis) || (when && when.kind === "relative" && !RE_IDEA.test(basis))) type = "task";
      else if (RE_IDEA.test(basis)) type = "idea";
      else if (RE_URL.test(basis)) type = "link";
      else type = "note";
    }

    const carryDue = type === "task" && when;
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text,
      type,
      tags,
      due: carryDue ? when.due : null,
      dueLabel: carryDue ? when.matched : null,
      priority,
      done: false,
      created: Date.now(),
      notified: false,
    };
  }

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

  function boardStats(drops, now = Date.now()) {
    return {
      openTasks: drops.filter((d) => d.type === "task" && !d.done).length,
      dueToday: drops.filter((d) => isTaskDueToday(d, now) && !isHiddenFromAttention(d, now)).length,
      overdue: drops.filter((d) => isRecentlyOverdue(d, now) && !isHiddenFromAttention(d, now)).length,
      ideas: drops.filter((d) => d.type === "idea").length,
      all: drops.length,
    };
  }

  function formatDueWhen(due, now) {
    const dueD = new Date(due);
    const nowD = new Date(now);
    const sameDay = dueD.toDateString() === nowD.toDateString();
    const timeStr = dueD.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const dateStr = dueD.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    return { sameDay, timeStr, dateStr, when: sameDay ? timeStr : dateStr };
  }

  function dueBadge(d, now = Date.now()) {
    if (!d || !d.due || d.type !== "task" || d.attentionDismissed) return null;
    const { sameDay, timeStr, dateStr, when } = formatDueWhen(d.due, now);
    if (d.done) return { cls: "done-badge", label: `✓ was due ${when}` };
    if (d.due < now && !sameDay && now - d.due > OVERDUE_WINDOW_MS) {
      return { cls: "past", label: `past · ${dateStr}` };
    }
    if (d.due < now) return { cls: "over", label: `⚠ overdue · ${when}` };
    if (sameDay) return { cls: "today", label: `⏰ today ${timeStr}` };
    return { cls: "later", label: `📅 ${dateStr} ${timeStr}` };
  }

  function dismissDrop(d) {
    d.attentionDismissed = true;
    d.attentionSnoozed = false;
    return d;
  }

  function snoozeDrop(d, now = Date.now()) {
    d.attentionUntil = now + SNOOZE_DAYS * DAY;
    d.attentionSnoozed = true;
    d.attentionDismissed = false;
    return d;
  }

  root.BraindropLogic = {
    OVERDUE_WINDOW_DAYS,
    URGENT_WINDOW_DAYS,
    SNOOZE_DAYS,
    shortTitle,
    displayTitle,
    emailView,
    isEmailDrop,
    parseWhen,
    classify,
    dueBadge,
    needsAttention,
    isStaleAttention,
    isTaskDueToday,
    isRecentlyOverdue,
    partitionBoard,
    boardStats,
    dismissDrop,
    snoozeDrop,
    attentionSort,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
