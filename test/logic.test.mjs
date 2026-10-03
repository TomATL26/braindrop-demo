import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../braindrop-logic.js", import.meta.url), "utf8");
const sandbox = { URL, decodeURIComponent, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const L = sandbox.BraindropLogic;
assert.ok(L, "BraindropLogic loaded");

const now = Date.parse("2026-10-02T22:00:00Z");
const t = (iso) => Date.parse(iso);

function drop(partial) {
  return {
    id: partial.id || "x",
    type: "task",
    text: "task",
    done: false,
    priority: false,
    created: t("2026-07-25T18:00:00Z"),
    ...partial,
  };
}

const health = drop({
  id: "health",
  text: "Health follow-ups 25 Jul 2026 -- Dr. Dillig (Sept), cardiology, labs",
  due: t("2026-08-03T15:00:00Z"),
  priority: true,
  source: "email",
  emailFrom: "mcgurk@gmail.com",
  body: "Follow-ups generated 25 Jul 2026.\n\nSent from my iPhone\n[image]\n755373778_18034059707817641_5267109521428803462_n.jpg\nPlease book cardiology.",
});
const addendum = drop({
  id: "addendum",
  type: "note",
  text: "ADDENDUM 25 Jul 2026 -- Achilles confirmed bilateral; BP gap; carotid repeat",
  due: t("2026-08-10T15:00:00Z"),
  source: "email",
  body: "Addendum to the 25 Jul 2026 follow-ups.\nSent from my iPhone",
});
const annual = drop({
  id: "annual",
  type: "note",
  text: "Annual meeting September/October 2026",
  due: t("2026-08-30T15:00:00Z"),
  source: "email",
});
const recent = drop({
  id: "recent",
  text: "Pay the water bill",
  due: now - 2 * 60 * 60 * 1000,
  priority: true,
  created: now - 5 * 60 * 60 * 1000,
});
const today = drop({
  id: "today",
  text: "Call the dentist",
  due: now + 60 * 60 * 1000,
  created: now - 60 * 60 * 1000,
});
const upcoming = drop({
  id: "rover",
  text: "Task: October 12, arrange Land Rover service",
  due: t("2026-10-12T15:00:00Z"),
  created: t("2026-07-24T18:00:00Z"),
});

assert.equal(L.needsAttention(health, now), false, "months-old urgent email is not needs-attention");
assert.equal(L.isStaleTask(health, now), true, "months-old task is in the stale pile");
assert.equal(L.needsAttention(addendum, now), false);
assert.equal(L.isStaleTask(addendum, now), false, "notes are not overdue");
assert.equal(L.duePresentation(addendum, now), null);
assert.equal(L.duePresentation(annual, now), null);
assert.equal(L.needsAttention(recent, now), true, "overdue inside two weeks still needs attention");
assert.equal(L.duePresentation(recent, now).cls, "over");
assert.equal(L.needsAttention(today, now), true);
assert.equal(L.isDueToday(today, now), true);
assert.equal(L.needsAttention(upcoming, now), false, "a future task stays on the board, not in the pile");
assert.equal(L.needsAttention({ ...health, attentionDismissed: true }, now), false);
assert.equal(L.isStaleTask({ ...health, attentionDismissed: true }, now), false);
assert.equal(L.isStaleTask({ ...health, snoozedUntil: now + L.DAY }, now), false);
assert.equal(L.needsAttention({ ...today, done: true }, now), false);

assert.match(L.displayTitle(health), /Health follow-ups/);
assert.doesNotMatch(L.displayTitle(health), /25 Jul 2026/);
assert.match(L.displayTitle(addendum), /^Addendum — Achilles/);
assert.match(L.cleanEmailBody(health.body), /Please book cardiology/);
assert.doesNotMatch(L.cleanEmailBody(health.body), /iPhone/);
assert.doesNotMatch(L.cleanEmailBody(health.body), /755373778/);

const fb = "https://www.facebook.com/reel/1384349603876516/?fs=e&extra=1";
const fbDrop = drop({ type: "link", text: fb, tags: ["facebook", "video"] });
const fbInfo = L.describeLink(fbDrop);
assert.equal(fbInfo.title, "Facebook video");
assert.equal(fbInfo.domain, "facebook.com");
assert.ok(!fbInfo.title.startsWith("http"), "raw URL is not the title");

const apple = L.describeLink(drop({
  type: "link",
  text: "https://apple.news/AfctIyKwmTmi664DLJ47\nKog",
}));
assert.equal(apple.title, "Kog");
assert.equal(apple.domain, "apple.news");

const x = L.describeLink(drop({
  type: "link",
  text: "https://x.com/Cypher_Ai1/status/2086107459937321123?s=20",
}));
assert.equal(x.title, "Post on X");
assert.equal(x.domain, "x.com");

const watch = L.describeLink(drop({ type: "link", text: "https://fb.watch/v/7dYwQjDeN/" }));
assert.equal(watch.title, "Facebook video");

const wineA = drop({
  id: "w1", type: "note", source: "email",
  text: "Shipping Options for Your Wines in Storage",
  created: t("2026-07-24T19:00:00Z"),
});
const wineB = drop({
  id: "w2", type: "note", source: "email",
  text: "Shipping Options for Your Wines in Storage",
  created: t("2026-07-25T17:00:00Z"),
  body: "October 2025 Update",
});
const folded = L.foldEmailDupes([wineA, wineB, today]);
assert.equal(folded.filter(d => /Shipping Options/.test(d.text)).length, 1);
assert.equal(folded.find(d => /Shipping/.test(d.text)).id, "w2");
assert.ok(folded.some(d => d.id === "today"));

const exported = L.exportDrop({ ...fbDrop, done: false });
assert.equal(exported.linkTitle, "Facebook video");
assert.equal(exported.linkDomain, "facebook.com");
assert.equal(exported.text, fb, "export keeps the original URL");
const archived = L.exportDrop({ ...today, done: true, doneAt: now });
assert.equal(archived.done, true);
assert.equal(archived.text, today.text);

const preview = L.unfurlFromHtml(
  `<html><head>
    <meta property="og:title" content="Notifications API">
    <meta property="og:description" content="How the browser notifies a user.">
    <title>Ignored</title>
  </head></html>`,
  "https://developer.mozilla.org/docs"
);
assert.equal(preview.title, "Notifications API");
assert.match(preview.description, /notifies/);
assert.equal(preview.domain, "developer.mozilla.org");

const wall = L.unfurlFromHtml("<html><head><title>Log in to Facebook</title></head></html>", "https://facebook.com/reel/1");
assert.equal(wall.title, "");
assert.equal(L.isJunkTitle("Facebook"), true);
assert.equal(L.isJunkTitle("Facebook video"), false);

assert.equal(L.matchesQuery(archived, "dentist"), true);
assert.equal(L.matchesQuery(fbDrop, "#video"), true);

console.log("logic tests ok");
