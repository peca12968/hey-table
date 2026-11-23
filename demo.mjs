// Run the restaurant locally. Only the station's actual exported JSON reaches the CLI.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const site = resolve(process.argv[2]);
const require = createRequire(join(site, "package.json"));
const {build} = require("esbuild");
const {Miniflare} = require("miniflare");
const bundle = await build({stdin: {
  contents: 'import {api} from "./server/api.mjs"; export default {fetch:api};',
  resolveDir: site
}, bundle: true, format: "esm", write: false});
const staff = randomUUID();
const app = new Miniflare({modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-05-15", d1Databases: ["DB"], bindings: {STAFF_KEY: staff}});
const dir = await mkdtemp(join(tmpdir(), "ready-range-"));

try {
  const db = await app.getD1Database("DB");
  const migrations = join(site, "drizzle");
  const journal = JSON.parse(await readFile(join(migrations, "meta", "_journal.json"), "utf8"));
  for (const {tag} of journal.entries) {
    const sql = await readFile(join(migrations, tag + ".sql"), "utf8");
    for (const part of sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) {
      await db.prepare(part).run();
    }
  }
  async function call(route, {method = "GET", body, token, expected = 200} = {}) {
    const headers = {"Content-Type": "application/json"};
    if (token) headers["X-Ticket"] = token;
    if (route.startsWith("kitchen/")) headers.Authorization = "Bearer " + staff;
    const result = await app.dispatchFetch("http://restaurant.test/api/" + route, {
      method, headers, body: body && JSON.stringify(body)
    });
    const data = await result.json();
    assert.equal(result.status, expected, JSON.stringify(data));
    return data;
  }
  const captures = [];
  async function capture() {
    const file = join(dir, captures.length + ".json");
    await writeFile(file, JSON.stringify(await call("kitchen/stations")));
    captures.push(file);
  }
  const methods = ["line_pay", "px_pay_plus", "jko_pay", "easy_wallet", "pi_wallet", "plus_pay", "card", "cash"];
  const tickets = [];
  for (const [index, paymentMethod] of methods.entries()) {
    const token = randomUUID();
    const mode = index % 2 ? "pickup" : "table";
    const {id} = await call("orders", {method: "POST", token, body: {token, mode,
      table: mode === "table" ? "A03" : null, paymentMethod, note: "private-sentinel", items: [{id:"gyoza", qty:1}]}});
    tickets.push({id, token, paymentMethod});
  }
  await capture();
  async function transition(id, from, to, expected = 200) {
    await call("kitchen/status", {method:"PATCH", body:{id, from, to}, expected});
  }
  for (const {id, token, paymentMethod} of tickets) {
    if (paymentMethod !== "cash") {
      await transition(id, "pending", "preparing", 409);
      const {attempt} = await call("payments/start", {method:"POST", token, body:{}});
      await call("payments/demo", {method:"POST", token, body:{ref:attempt.ref, outcome:"paid"}});
      const ticket = await call("ticket", {token});
      assert.equal(ticket.paymentState, "paid");
      assert.equal(ticket.paymentMethod, paymentMethod);
    }
    if (paymentMethod === "cash") await transition(id, "pending", "cancelled");
    else await transition(id, "pending", "preparing");
  }
  await capture();
  for (const {id, paymentMethod} of tickets) {
    if (!["cash", "card"].includes(paymentMethod)) await transition(id, "preparing", "ready");
  }
  await capture();
  const cli = fileURLToPath(new URL("./ready.py", import.meta.url));
  const output = execFileSync(process.env.PYTHON || "python", [cli, "--target-seconds", "3600", ...captures],
    {encoding: "utf8"});
  assert.ok(!output.includes("private-sentinel"));
  const report = JSON.parse(output);
  assert.deepEqual(report.counts, {on_time:6, missed:1, uncertain:1});
  assert.deepEqual(report.onTimeCountRange, [6,7]);
  console.log(JSON.stringify({methods, observed:report.observed, counts:report.counts}));
} finally {
  await app.dispose();
  await rm(dir, {recursive:true, force:true});
}
