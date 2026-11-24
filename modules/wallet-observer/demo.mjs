import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath, pathToFileURL} from "node:url";

const site = resolve(process.argv[2] || fileURLToPath(new URL("../..", import.meta.url)));
const {api} = await import(pathToFileURL(join(site,"server/api.mjs")));
const cli = fileURLToPath(new URL("./observer.py",import.meta.url));
const dir = mkdtempSync(join(tmpdir(),"wallet-observer-"));
const file = join(dir,"demo.db");
const sqlite = new DatabaseSync(file);
// The production API calls D1's prepared-statement interface. The fixture uses
// SQLite on disk so the independent Python process can open the same database.
const DB = {prepare(sql){
  const statement = sqlite.prepare(sql);
  return {bind(...args){return {
    first:()=>statement.get(...args), run:()=>({meta:statement.run(...args)}),
    all:()=>({results:statement.all(...args)})
  };}};
}};
const python = (...args)=>execFileSync(process.env.PYTHON || "python",[cli,...args],{encoding:"utf8"});
const start = 1795406400000;
let now = start;
const originalNow = Date.now;
Date.now = ()=>now;
const originalFetch = globalThis.fetch;
globalThis.fetch = ()=>{throw Error("external calls are outside the demo");};
async function post(path, token, data) {
  const response = await api(new Request("https://local.example/api/"+path,{method:"POST",
    headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(data)}),{DB,TAPPAY_MODE:"demo"});
  const body = await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  return body;
}
async function order(method) {
  const token = randomUUID();
  await post("orders",token,{mode:"pickup",token,note:"private-order-note",items:[{id:"gyoza",qty:1}],paymentMethod:method});
  return {token, attempt:(await post("payments/start",token,{})).attempt};
}
const settle = (o,outcome)=>post("payments/demo",o.token,{ref:o.attempt.ref,outcome});
async function retry(o) {o.attempt = (await post("payments/start",o.token,{})).attempt;}
function capture() {
  const raw = python("capture",file,"--as-of-ms",String(now));
  assert.ok(!raw.includes("private-order-note"));
  const dest = join(dir,String(now)+".json");
  writeFileSync(dest,raw);
  return dest;
}
try {
  const migrations = join(site,"drizzle");
  for (const {tag} of JSON.parse(readFileSync(join(migrations,"meta","_journal.json"),"utf8")).entries) {
    sqlite.exec(readFileSync(join(migrations,tag+".sql"),"utf8"));
  }
  const [early,lineRetry,pending,pxEarly,pxRetry] = await Promise.all(
    ["line_pay","line_pay","line_pay","px_pay_plus","px_pay_plus"].map(order));
  const opened = capture();
  now = start+60000;
  await settle(early,"paid");
  await settle(pxEarly,"paid");
  await settle(lineRetry,"failed");
  await settle(pxRetry,"cancelled");
  const minute1 = capture();
  now = start+120000;
  await retry(lineRetry);
  now = start+240000;
  await settle(lineRetry,"paid");
  const minute4 = capture();
  now = start+330000;
  await retry(pxRetry);
  await settle(pxRetry,"paid");
  await order("px_pay_plus");
  now = start+360000;
  const end = capture();
  const report = (...files)=>JSON.parse(python("report","--seconds","300","--environment","demo",...files)).by_method;
  const sparse = report(opened,minute1,end);
  const dense = report(opened,minute1,minute4,end);
  assert.deepEqual(sparse.line_pay,{orders:3,attempts:4,immature:0,certain:1,missed:1,uncertain:1,eligible:3,on_time_count_range:[1,2]});
  assert.deepEqual(dense.line_pay.on_time_count_range,[2,2]);
  assert.deepEqual(sparse.px_pay_plus,{orders:3,attempts:4,immature:1,certain:1,missed:1,uncertain:0,eligible:2,on_time_count_range:[1,1]});
  assert.deepEqual(dense.px_pay_plus,sparse.px_pay_plus);
  assert.equal((await post("payments/check",pending.token,{})).attempt.state,"pending");
  console.log(JSON.stringify({sparse,dense},null,2));
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  sqlite.close();
  rmSync(dir,{recursive:true,force:true});
}
