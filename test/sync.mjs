import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import handler from "../worker/worker.js";
import puppeteer from "/tmp/bdtest/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const STATIC = 8771;
const API = 8772;
const TOKEN = "secret";

const memory = new Map();
const env = {
  DASH_TOKEN: TOKEN,
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
  const target = String(url);
  if (target.includes("api.telegram.org")) return new Response("{}", { status: 200 });
  if (target.startsWith(`http://127.0.0.1:${API}`)) return realFetch(url, opts);
  return realFetch(url, opts);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const api = http.createServer(async (req, res) => {
  try {
    const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
      else headers.set(key, value);
    }
    const response = await handler.fetch(new Request(`http://127.0.0.1:${API}${req.url}`, {
      method: req.method,
      headers,
      body: raw && raw.length ? raw : undefined,
    }), env);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err && err.stack || err));
  }
});

await new Promise(resolve => api.listen(API, "127.0.0.1", resolve));
const web = spawn("python3", ["-m", "http.server", String(STATIC), "--bind", "127.0.0.1"], {
  cwd: "/workspace",
  stdio: "ignore",
});
await new Promise(r => setTimeout(r, 300));

const now = Date.now();
const board = [
  { id: "fauda", type: "task", text: "Watch Fauda", done: false, created: now - 86400000, updated: now - 10000, tags: ["tv"] },
  { id: "ellie", type: "task", text: "Get Ellie's shot records to Reagan.", done: true, doneAt: now - 50000, created: now - 900000, updated: now - 50000, tags: ["pets"] },
  {
    id: "fb", type: "link",
    text: "https://www.facebook.com/reel/1384349603876516/?fs=e",
    done: false, created: now - 3600000, updated: now - 20000,
    linkTitle: "Facebook video", linkDomain: "facebook.com", linkTitleSource: "fetched",
    tags: ["facebook", "video"],
  },
];

async function syncState() {
  const res = await realFetch(`http://127.0.0.1:${API}/api/sync`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return res.json();
}
async function waitFor(fn, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < 10000) {
    try { if (await fn()) return; }
    catch (err) { last = err; }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error("timed out: " + label + (last ? " (" + last.message + ")" : ""));
}

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

try {
  const contextA = await browser.createBrowserContext();
  const contextB = await browser.createBrowserContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors = [];
  for (const page of [pageA, pageB]) page.on("pageerror", err => errors.push(String(err)));
  await pageA.setViewport({ width: 1100, height: 800 });
  await pageB.setViewport({ width: 820, height: 900 });

  const home = `http://127.0.0.1:${STATIC}/index.html`;
  await pageA.goto(home, { waitUntil: "domcontentloaded" });
  await pageA.evaluate((data, tokenUrl) => {
    localStorage.setItem("braindrop.v1", JSON.stringify(data));
    localStorage.setItem("braindrop.sync", JSON.stringify({ url: tokenUrl.url, token: tokenUrl.token }));
  }, board, { url: `http://127.0.0.1:${API}`, token: TOKEN });
  await pageA.reload({ waitUntil: "domcontentloaded" });

  await waitFor(async () => {
    const state = await syncState();
    return state.drops && state.drops.length === 3 && state.drops.some(d => d.id === "ellie" && d.done);
  }, "iPad upload");
  const storedA = await pageA.evaluate(() => JSON.parse(localStorage.getItem("braindrop.v1")).map(d => d.id).sort());
  assert.deepEqual(storedA, ["ellie", "fauda", "fb"], "first sync kept every local drop");
  console.log("ok first sync uploaded local drops without wiping them");

  await pageB.goto(home, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(tokenUrl => {
    localStorage.removeItem("braindrop.v1");
    localStorage.setItem("braindrop.sync", JSON.stringify({ url: tokenUrl.url, token: tokenUrl.token }));
  }, { url: `http://127.0.0.1:${API}`, token: TOKEN });
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await pageB.waitForSelector('[data-id="fauda"]');
  await pageB.waitForSelector('[data-id="fb"]');
  const fbTitle = await pageB.$eval('[data-id="fb"] .content', el => el.innerText.trim());
  assert.equal(fbTitle, "Facebook video");
  const ellieOnMain = await pageB.$('[data-id="ellie"]');
  assert.equal(ellieOnMain, null, "archived task stays off the main feed");
  await pageB.click('.chip[data-f="archive"]');
  await pageB.waitForSelector('[data-id="ellie"]');
  console.log("ok second device shows the same list, archive, and link title");

  await pageB.click('.chip[data-f="all"]');
  await pageB.waitForSelector('[data-id="fauda"] .checkbox');
  await pageB.click('[data-id="fauda"] .checkbox');
  await pageB.waitForFunction(() => !document.querySelector('[data-id="fauda"]'));
  await waitFor(async () => {
    const state = await syncState();
    return state.drops.find(d => d.id === "fauda" && d.done);
  }, "archive reached the worker");

  await pageA.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pageA.waitForFunction(() => !document.querySelector('[data-id="fauda"]'));
  await pageA.click('.chip[data-f="archive"]');
  await pageA.waitForSelector('[data-id="fauda"]');
  await pageA.waitForSelector('[data-id="ellie"]');
  console.log("ok archiving on one browser shows up on the other");

  await pageA.click('.chip[data-f="all"]');
  await pageA.click("#input");
  await pageA.type("#input", "Ping the harbor master tomorrow");
  await pageA.click("#sendBtn");
  await pageA.waitForFunction(() => document.body.innerText.includes("Ping the harbor master tomorrow"));
  await waitFor(async () => {
    const state = await syncState();
    return state.drops.some(d => /harbor master/.test(d.text));
  }, "new drop stored");
  await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pageB.waitForFunction(() => document.body.innerText.includes("Ping the harbor master tomorrow"));
  console.log("ok a new drop syncs to the other device");

  const tg = await realFetch(`http://127.0.0.1:${API}/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "tgsec" },
    body: JSON.stringify({ message: { chat: { id: 7 }, text: "Buy oat milk tomorrow" } }),
  });
  assert.equal(tg.status, 200);
  await pageA.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pageA.waitForFunction(() => document.body.innerText.includes("Buy oat milk tomorrow"));
  await pageB.waitForFunction(() => document.body.innerText.includes("Buy oat milk tomorrow"));
  console.log("ok telegram capture lands on both devices");

  const finalStore = await syncState();
  assert.ok(finalStore.drops.some(d => d.source === "telegram" && /oat milk/.test(d.text)));
  assert.ok(finalStore.drops.some(d => d.id === "ellie" && d.done));
  assert.ok(finalStore.drops.some(d => d.id === "fb" && d.linkTitle === "Facebook video"));
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("sync tests ok");
} finally {
  globalThis.fetch = realFetch;
  await browser.close();
  api.close();
  web.kill();
}
