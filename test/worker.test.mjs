import assert from "node:assert/strict";
import * as worker from "../worker/worker.js";

const now = Date.parse("2026-10-02T22:00:00Z");
const t = (iso) => Date.parse(iso);

assert.equal(worker.subjectDeadline("Call Peter about repayment August 19", now), null);
assert.equal(worker.subjectDeadline("Health follow-ups 25 Jul 2026 -- Dr. Dillig", now), null);

const capturedEarly = Date.parse("2026-08-01T15:00:00Z");
const aug19 = worker.subjectDeadline("Call Peter about repayment August 19", capturedEarly);
assert.ok(aug19, "a subject date still in front of the sender is kept");
assert.ok(aug19 > capturedEarly);

const tomorrow = worker.subjectDeadline("Ping Jimmy tomorrow", Date.parse("2026-07-27T15:00:00Z"));
assert.ok(tomorrow > Date.parse("2026-07-27T15:00:00Z"));

const body = worker.cleanEmailNoise("Go pick up the wines.\nSent from my iPhone\n[image]\n755373778_18034059707817641_n.jpg\n");
assert.match(body, /pick up the wines/);
assert.doesNotMatch(body, /iPhone/);
assert.doesNotMatch(body, /755373778/);

assert.match(worker.shortTitle("ADDENDUM 25 Jul 2026 -- Achilles confirmed bilateral"), /^Addendum — Achilles/);

const old = {
  type: "task",
  text: "Health follow-ups",
  due: t("2026-08-03T15:00:00Z"),
  priority: true,
  done: false,
  created: t("2026-07-25T18:00:00Z"),
};
assert.equal(worker.needsAttention(old, now), false);
assert.equal(worker.needsAttention({ ...old, type: "note" }, now), false);
assert.equal(worker.needsAttention({
  type: "task", text: "Pay the water bill", due: now - 3600e3, done: false, created: now, priority: true,
}, now), true);
assert.equal(worker.needsAttention({
  type: "link", text: "https://x.com/a/status/1", due: t("2026-08-01T00:00:00Z"), done: false, created: t("2026-08-01T00:00:00Z"),
}, now), false);

assert.equal(worker.briefLabel({ text: "https://www.facebook.com/reel/1", linkTitle: "Facebook video" }), "Facebook video");
assert.equal(worker.isPublicHttpUrl("https://example.com/a"), true);
assert.equal(worker.isPublicHttpUrl("http://127.0.0.1/latest"), false);
assert.equal(worker.isPublicHttpUrl("http://169.254.169.254/latest"), false);
assert.equal(worker.isPublicHttpUrl("http://localhost/admin"), false);
assert.equal(worker.isPublicHttpUrl("file:///etc/passwd"), false);

const preview = worker.unfurlFromHtml(
  '<meta property="og:title" content="Fauda"><meta name="description" content="A television series.">',
  "https://example.com/fauda"
);
assert.equal(preview.title, "Fauda");
assert.match(preview.description, /television/);

const login = worker.unfurlFromHtml("<title>Facebook</title>", "https://facebook.com/reel/9");
assert.equal(login.title, "");

const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../worker/worker.js", import.meta.url), "utf8"));
assert.match(src, /pathname === "\/telegram"/);
assert.match(src, /classify\(text, env, "telegram"\)/);
assert.match(src, /async function telegram/);
assert.match(src, /\/api\/unfurl/);

const applyImport = worker.applyImport;
const sanitizeDrop = worker.sanitizeDrop;
const handler = worker.default;

const memory = new Map();
const env = {
  DASH_TOKEN: "secret",
  TELEGRAM_SECRET: "tgsec",
  TELEGRAM_TOKEN: "unused",
  DROPS: {
    async get(key, type) {
      if (!memory.has(key)) return null;
      const value = memory.get(key);
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { memory.set(key, String(value)); },
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.telegram.org")) return new Response("{}", { status: 200 });
  return realFetch(url, opts);
};

async function call(path, { method = "GET", body, token = "secret", headers = {} } = {}) {
  const res = await handler.fetch(new Request("https://worker.test" + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, json };
}

const localBoard = [
  { id: "fauda", type: "task", text: "Watch Fauda", done: false, created: 1000, tags: ["tv"] },
  { id: "ellie", type: "task", text: "Get Ellie's shot records to Reagan.", done: true, doneAt: 1500, created: 900, tags: ["pets"] },
  {
    id: "fb", type: "link", text: "https://www.facebook.com/reel/1384349603876516/?fs=e",
    done: false, created: 2000, linkTitle: "Facebook video", linkDomain: "facebook.com", linkTitleSource: "heuristic", tags: ["facebook"],
  },
];

let synced = await call("/api/drops/import", { method: "POST", body: { drops: localBoard } });
assert.equal(synced.status, 200);
assert.equal(synced.json.drops.length, 3);
const ellie = synced.json.drops.find(d => d.id === "ellie");
assert.equal(ellie.done, true, "archive flag survives upload");
const fb = synced.json.drops.find(d => d.id === "fb");
assert.equal(fb.linkTitle, "Facebook video");

const tg = await call("/telegram", {
  method: "POST",
  token: "",
  headers: { "X-Telegram-Bot-Api-Secret-Token": "tgsec", Authorization: "" },
  body: { message: { chat: { id: 1 }, text: "Buy oat milk tomorrow" } },
});
assert.equal(tg.status, 200);
synced = await call("/api/sync");
assert.equal(synced.json.drops.length, 4, "telegram lands in the same store");
assert.ok(synced.json.drops.some(d => /oat milk/i.test(d.text) && d.source === "telegram"));

const again = await call("/api/drops/import", { method: "POST", body: { drops: localBoard } });
assert.equal(again.json.drops.length, 4, "re-upload does not duplicate or wipe telegram");

const otherDevice = await call("/api/drops/import", {
  method: "POST",
  body: { drops: [{ id: "rover", type: "task", text: "Land Rover service", done: false, created: 3000, updated: Date.now() }] },
});
assert.ok(otherDevice.json.drops.some(d => d.id === "fauda"));
assert.ok(otherDevice.json.drops.some(d => d.id === "rover"));
assert.equal(otherDevice.json.drops.find(d => d.id === "ellie").done, true);

const archived = await call("/api/drops/fauda", { method: "PATCH", body: { done: true, doneAt: 4000, updated: Date.now() } });
assert.equal(archived.status, 200);
assert.equal(archived.json.done, true);
const afterArchive = await call("/api/sync");
assert.equal(afterArchive.json.drops.find(d => d.id === "fauda").done, true);

await call("/api/drops/rover", { method: "DELETE" });
const resurrect = await call("/api/drops/import", {
  method: "POST",
  body: { drops: [{ id: "rover", type: "task", text: "Land Rover service", done: false, created: 3000, updated: 1 }] },
});
assert.ok(!resurrect.json.drops.some(d => d.id === "rover"), "deleted drops stay deleted");

const posted = await call("/api/drops", { method: "POST", body: { text: "note: gate code is 4482", id: "gatecode1" } });
assert.equal(posted.status, 201);
assert.equal(posted.json.id, "gatecode1");
assert.equal(posted.json.type, "note");

const denied = await call("/api/sync", { token: "nope" });
assert.equal(denied.status, 401);

const kept = applyImport(
  [{ id: "tg1", text: "from telegram", type: "task", created: 5, source: "telegram" }],
  [],
  [{ id: "local1", text: "from the ipad", type: "note", created: 6, done: true }],
  []
);
assert.deepEqual(kept.drops.map(d => d.id).sort(), ["local1", "tg1"]);
assert.equal(sanitizeDrop({ id: "bad id", text: "x" }), null);

globalThis.fetch = realFetch;
console.log("worker tests ok");
