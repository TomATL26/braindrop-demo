/**
 * Pure board rules shared by the dashboard (classic script global).
 * Keep the worker's email deadline policy aligned with ATTENTION_WINDOW_MS.
 *
 * Needs attention:
 *   - open tasks due today
 *   - open tasks overdue within ATTENTION_WINDOW_MS
 *   - urgent tasks that are still inside that window
 * Notes, ideas, links, and quotes are never overdue from a parsed date.
 * Older tasks can be snoozed or dismissed without deleting text.
 */
(function (root) {
  const DAY = 24 * 60 * 60 * 1000;
  const ATTENTION_WINDOW_MS = 14 * DAY;

  function cleanEmailBody(body) {
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

  function isImageFilename(t) {
    const name = t.replace(/^<|>$/g, "");
    if (!/\.(png|jpe?g|gif|webp|heic)$/i.test(name)) return false;
    if (/\d{5,}/.test(name)) return true;
    return name.length > 40;
  }

  function shortTitle(text) {
    let t = String(text || "").replace(/\s+/g, " ").trim();
    t = t.replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, "");
    t = t.replace(
      /^(addendum|update|reminder)\s+\d{1,2}\s+[A-Za-z]{3,12}\s+\d{2,4}\s*[—–\-|:]+\s*/i,
      (_, w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() + " — "
    );
    t = t.replace(
      /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{4}\b/gi,
      " "
    );
    t = t.replace(/\s*[—–]{1,}\s*/g, " — ");
    t = t.replace(/\s{2,}/g, " ").replace(/\s+—\s*$/g, "").replace(/^[\s—–\-|:]+/, "").trim();
    if (t.length > 92) {
      const cut = t.slice(0, 92);
      const pivot = Math.max(cut.lastIndexOf(" — "), cut.lastIndexOf("; "), cut.lastIndexOf(", "), cut.lastIndexOf(" "));
      t = (pivot > 36 ? cut.slice(0, pivot) : cut).trim().replace(/[,\s—–\-|:]+$/g, "") + "…";
    }
    return t;
  }

  function isEmailDrop(d) {
    return !!(d && (d.source === "email" || d.emailFrom));
  }

  function looksLikeEmail(d) {
    if (!d) return false;
    if (isEmailDrop(d)) return true;
    return typeof d.body === "string" && d.body.length > 80;
  }

  function firstUrl(text) {
    const m = String(text || "").match(/https?:\/\/[^\s<]+/i);
    if (!m) return null;
    return m[0].replace(/[),.;]+$/g, "");
  }

  function linkCaption(text) {
    let rest = String(text || "").replace(/https?:\/\/[^\s<]+/gi, " ");
    rest = rest.replace(/#([\p{L}\p{N}_-]+)/gu, " ");
    rest = rest.replace(/\s+/g, " ").trim();
    return rest;
  }

  function heuristicLink(url) {
    let u;
    try { u = new URL(url); }
    catch { return { title: "Saved link", domain: "" }; }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname || "";
    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch" || host === "fb.com" || host === "m.facebook.com") {
      const video = host === "fb.watch" || /\/(reel|watch|videos?)\b/i.test(path) || /\/share\/r\//i.test(path);
      return { title: video ? "Facebook video" : "Facebook post", domain: "facebook.com" };
    }
    if (host === "apple.news") return { title: "Apple News", domain: "apple.news" };
    if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com" || host === "mobile.x.com") {
      return { title: "Post on X", domain: "x.com" };
    }
    if (host === "youtu.be" || host.endsWith("youtube.com")) return { title: "YouTube video", domain: "youtube.com" };
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return { title: "Instagram", domain: "instagram.com" };
    if (host.endsWith(".substack.com") || host === "substack.com") {
      const sub = host.replace(/\.substack\.com$/, "");
      const pretty = sub && sub !== "www" && sub !== "substack"
        ? sub.charAt(0).toUpperCase() + sub.slice(1)
        : "Substack";
      return { title: pretty + " on Substack", domain: host };
    }
    const parts = path.split("/").filter(Boolean).map(p => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    const slug = parts.reverse().find(p =>
      /[a-zA-Z]{3,}/.test(p) && p.length < 60 && !/^[A-Za-z0-9_-]{16,}$/.test(p)
    );
    if (slug) {
      const pretty = slug.replace(/\.(html?|php|aspx)$/i, "").replace(/[-_]+/g, " ").trim();
      if (pretty.length > 2) {
        return { title: pretty.charAt(0).toUpperCase() + pretty.slice(1), domain: host };
      }
    }
    return { title: host, domain: host };
  }

  function isJunkTitle(title) {
    const t = String(title || "").trim().toLowerCase();
    if (!t || t.length < 3) return true;
    if (/^https?:\/\//i.test(t)) return true;
    if (/^(log\s?in|login|sign\s?up|signup|facebook|instagram|apple news|twitter|just a moment|attention required|access denied|forbidden|error|403|404|page not found|redirecting|cookie policy)$/.test(t)) return true;
    if (t.length < 48 && /\b(log\s?in|sign\s?in|sign\s?up)\b/.test(t)) return true;
    return false;
  }

  function describeLink(d) {
    const url = firstUrl(d && d.text) || firstUrl(d && d.body) || null;
    const caption = linkCaption(d && d.text);
    const heuristic = url ? heuristicLink(url) : { title: "Saved link", domain: (d && d.linkDomain) || "" };
    const stored = d && d.linkTitle && !isJunkTitle(d.linkTitle) ? String(d.linkTitle).trim() : "";
    const fetched = d && d.linkTitleSource === "fetched" ? stored : "";
    const title = (caption || fetched || stored || heuristic.title || "Saved link").trim();
    const description = d && d.linkDescription ? String(d.linkDescription).trim() : "";
    return {
      title,
      description: description && description !== title ? description : "",
      domain: (d && d.linkDomain) || heuristic.domain || "",
      url,
      caption,
    };
  }

  function displayTitle(d) {
    if (!d) return "";
    if (d.type === "link") return describeLink(d).title;
    const raw = String(d.text || "").replace(/\s+/g, " ").trim();
    if (looksLikeEmail(d)) return shortTitle(raw) || raw;
    return raw;
  }

  function blockedFromAttention(d, now) {
    if (!d || d.done) return true;
    if (d.attentionDismissed) return true;
    if (d.snoozedUntil && d.snoozedUntil > now) return true;
    return false;
  }

  function isDueToday(d, now = Date.now()) {
    if (!d || d.type !== "task" || !d.due || d.done) return false;
    return new Date(d.due).toDateString() === new Date(now).toDateString();
  }

  function urgentRelevant(d, now) {
    if (!d.priority || d.type !== "task") return false;
    if (d.due) return Math.abs(d.due - now) <= ATTENTION_WINDOW_MS || isDueToday(d, now);
    return now - (d.created || 0) <= ATTENTION_WINDOW_MS;
  }

  function needsAttention(d, now = Date.now()) {
    if (blockedFromAttention(d, now)) return false;
    if (d.type !== "task") {
      // A fresh urgent note can surface. A date parsed off an old email cannot.
      return !!(d.priority && !d.due && now - (d.created || 0) <= ATTENTION_WINDOW_MS);
    }
    if (isDueToday(d, now)) return true;
    if (d.due && d.due < now && now - d.due <= ATTENTION_WINDOW_MS) return true;
    if (urgentRelevant(d, now)) return true;
    return false;
  }

  function isStaleTask(d, now = Date.now()) {
    if (!d || d.done || d.type !== "task") return false;
    if (d.attentionDismissed) return false;
    if (d.snoozedUntil && d.snoozedUntil > now) return false;
    if (!d.due || d.due >= now) return false;
    if (needsAttention(d, now)) return false;
    return true;
  }

  function duePresentation(d, now = Date.now()) {
    if (!d || !d.due) return null;
    const due = new Date(d.due);
    const nowDate = new Date(now);
    const sameDay = due.toDateString() === nowDate.toDateString();
    const timeStr = due.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const dateStr = due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (d.type !== "task") {
      if (d.due < now) return null;
      return { cls: "later", label: "📅 " + (sameDay ? timeStr : dateStr) };
    }
    if (d.done) return { cls: "done-badge", label: "✓ was due " + (sameDay ? timeStr : dateStr) };
    if (d.due < now && !sameDay) {
      if (now - d.due > ATTENTION_WINDOW_MS) return { cls: "stale", label: "past due · " + dateStr };
      return { cls: "over", label: "⚠ overdue · " + dateStr };
    }
    if (d.due < now) return { cls: "over", label: "⚠ overdue · " + timeStr };
    if (sameDay) return { cls: "today", label: "⏰ today " + timeStr };
    return { cls: "later", label: "📅 " + dateStr + " " + timeStr };
  }

  function emailDupeKey(d) {
    if (!isEmailDrop(d)) return null;
    const base = String(d.text || "").toLowerCase()
      .replace(/^(?:(?:re|fwd?|fw)\s*:?\s*)+/, "")
      .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    if (base.length < 12) return null;
    return base.slice(0, 90);
  }

  function foldEmailDupes(items) {
    const seen = new Set();
    const out = [];
    const sorted = [...items].sort((a, b) => (b.created || 0) - (a.created || 0));
    for (const d of sorted) {
      const key = emailDupeKey(d);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(d);
    }
    return out;
  }

  function matchesQuery(d, query) {
    if (!query) return true;
    const q = String(query).toLowerCase();
    const hay = [d.text, d.body, d.title, d.linkTitle, d.linkDescription, d.linkDomain, d.emailFrom]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (hay.includes(q)) return true;
    const bare = q.replace(/^#/, "");
    return (d.tags || []).some(t => t.includes(bare) || ("#" + t).includes(q));
  }

  function exportDrop(d) {
    const copy = { ...d };
    if (d.type === "link") {
      const info = describeLink(d);
      copy.linkTitle = info.title;
      if (info.description) copy.linkDescription = info.description;
      if (info.domain) copy.linkDomain = info.domain;
      if (info.title && info.title !== d.text) copy.title = info.title;
    } else {
      const title = displayTitle(d);
      const raw = String(d.text || "").replace(/\s+/g, " ").trim();
      if (title && title !== raw) copy.title = title;
    }
    return copy;
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

  function decodeEntities(s) {
    return String(s || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&nbsp;/g, " ");
  }

  root.BraindropLogic = {
    ATTENTION_WINDOW_MS,
    DAY,
    cleanEmailBody,
    shortTitle,
    isEmailDrop,
    looksLikeEmail,
    firstUrl,
    linkCaption,
    heuristicLink,
    isJunkTitle,
    describeLink,
    displayTitle,
    isDueToday,
    needsAttention,
    isStaleTask,
    duePresentation,
    emailDupeKey,
    foldEmailDupes,
    matchesQuery,
    exportDrop,
    unfurlFromHtml,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
