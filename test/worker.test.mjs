import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import {
  regexClassify,
  sanitizeCapturedEmail,
  partitionBoard,
  splitEmailContent,
} from "../worker/worker.js";

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../logic.js", import.meta.url), "utf8"), sandbox);
const L = sandbox.BraindropLogic;

function at(y, m, d, h = 9, min = 0) {
  return new Date(y, m, d, h, min, 0, 0).getTime();
}
const NOW = at(2026, 9, 2, 18, 38);

test("worker regex does not promote prose dates or non-tasks", () => {
  const note = regexClassify("Annual meeting September 30, 2026");
  assert.equal(note.type, "note");
  assert.equal(note.due, null);

  const monday = regexClassify("Notes from Monday's standup");
  assert.equal(monday.type, "note");
  assert.equal(monday.due, null);

  const task = regexClassify("Call Peter about repayment August 19");
  assert.equal(task.type, "task");
  assert.equal(typeof task.due, "number");

  const relative = regexClassify("dentist tomorrow");
  assert.equal(relative.type, "task");
  assert.ok(relative.due > Date.now());
});

test("email sanitize drops historical and non-task dues without touching text", () => {
  const text = "Health follow-ups 25 Jul 2026 -- Dr. Dillig (Sept), cardiology, labs";
  const body = "Follow-ups generated 25 Jul 2026. Call Monday, August 3.";
  const note = sanitizeCapturedEmail({ text, body, type: "note", due: at(2026, 7, 10) }, NOW);
  assert.equal(note.due, null);
  assert.equal(note.text, text);
  assert.equal(note.body, body);

  const ancient = sanitizeCapturedEmail({ text, body, type: "task", due: at(2026, 7, 3) }, NOW);
  assert.equal(ancient.due, null);
  assert.equal(ancient.text, text);

  const soon = sanitizeCapturedEmail({ text: "Call Peter", body, type: "task", due: NOW + 3 * 24 * 60 * 60 * 1000 }, NOW);
  assert.equal(soon.due, NOW + 3 * 24 * 60 * 60 * 1000);
});

test("forwarded body is kept but not used as the sender note", () => {
  const raw = [
    "please file this",
    "",
    "---------- Forwarded message ----------",
    "From: clinic@example.com",
    "Date: Fri, 25 Jul 2026",
    "Subject: Health follow-ups",
    "",
    "Please call the office on Monday, August 3. urgent",
  ].join("\n");
  const split = splitEmailContent(raw);
  assert.equal(split.senderNote, "please file this");
  assert.ok(split.content.includes("August 3"));
  assert.ok(split.content.includes("please file this"));

  const unmarked = splitEmailContent("Generated 25 Jul 2026.\nCall Monday, August 3 about labs.");
  assert.equal(unmarked.senderNote, "");
  assert.ok(unmarked.content.includes("August 3"));
});

test("worker attention matches the dashboard on a populated board", () => {
  const drops = [
    { id: "health", type: "task", priority: true, due: at(2026, 7, 3), created: at(2026, 6, 25), done: false, text: "health" },
    { id: "note", type: "note", due: at(2026, 7, 10), created: at(2026, 6, 25), done: false, text: "note" },
    { id: "today", type: "task", due: at(2026, 9, 2, 16), created: at(2026, 9, 2, 8), done: false, text: "today" },
    { id: "urgent", type: "task", priority: true, due: null, created: at(2026, 9, 1, 9), done: false, text: "urgent" },
  ];
  const worker = partitionBoard(drops, NOW);
  const dash = L.partitionBoard(drops, NOW);
  assert.deepEqual(Array.from(worker.attention, (d) => d.id), Array.from(dash.attention, (d) => d.id));
  assert.deepEqual(Array.from(worker.stale, (d) => d.id).sort(), Array.from(dash.stale, (d) => d.id).sort());
  assert.deepEqual(Array.from(worker.attention, (d) => d.id), ["today", "urgent"]);
});
