import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";

if (!process.argv[2]) throw Error("Usage: node worker-demo.mjs PATH_TO_HEY_TABLE");
const checkout = resolve(process.argv[2]), cwd = fileURLToPath(new URL(".",import.meta.url));
const requireSite = createRequire(join(checkout,"package.json"));
const {build} = requireSite("esbuild"), {Miniflare} = requireSite("miniflare");
const {outputFiles} = await build({stdin:{contents:'import {api} from "./server/api.mjs"; export default {fetch:api}',resolveDir:checkout},
  bundle:true,format:"esm",write:false});
const key = randomUUID();
const service = new Miniflare({modules:true,script:outputFiles[0].text,compatibilityDate:"2026-05-15",
  host:"127.0.0.1",d1Databases:["DB"],bindings:{STAFF_KEY:key}});
const dir = await mkdtemp(join(tmpdir(),"pickup-window-"));
try {
  const db = await service.getD1Database("DB");
  const journal = JSON.parse(await readFile(join(checkout,"drizzle/meta/_journal.json"),"utf8"));
  for (const {tag} of journal.entries) {
    const migration = await readFile(join(checkout,"drizzle",tag+".sql"),"utf8");
    for (const stmt of migration.split("--> statement-breakpoint")) if(stmt.trim()) await db.prepare(stmt.trim()).run();
  }
  const base = (await service.ready).origin;
  async function call(path,method,body,expected=200) {
    const response = await fetch(base+path,{method, headers:{"Content-Type":"application/json",
      ...(path.startsWith("/api/kitchen") ? {Authorization:"Bearer "+key} : {})},body:JSON.stringify(body)});
    assert.equal(response.status,expected); return response.json();
  }
  function order(items, paymentMethod="cash") {
    return call("/api/orders","POST",{token:randomUUID(),mode:"pickup",note:"私人備註",items,paymentMethod});
  }
  function status(id,from,to,expected) {
    return call("/api/kitchen/status","PATCH",{id,from,to},expected);
  }
  async function quote() {
    const file = join(dir,"snapshot.json");
    await writeFile(file,JSON.stringify(await call("/api/kitchen/stations","GET")));
    const output = execFileSync(process.execPath,["cli.mjs",file,"examples/kitchen.json","--cart","examples/cart.json"],{cwd,encoding:"utf8"});
    assert.ok(!output.includes("私人備註")); return JSON.parse(output);
  }
  const first = await order([{id:"oyakodon",qty:3},{id:"sencha",qty:2}]);
  const second = await order([{id:"karaage",qty:2}]);
  const unpaid = await order([{id:"oyakodon",qty:20}],"px_pay_plus");
  await status(unpaid.id,"pending","preparing",409);
  await status(first.id,"pending","preparing"); await status(second.id,"pending","preparing");
  const before = await quote();
  assert.deepEqual(before.orders.map(r=>r.orderId),[first.id,second.id]);
  assert.deepEqual(before.quote.seconds,[660,840]);
  await status(first.id,"preparing","ready");
  const after = await quote();
  assert.deepEqual(after.orders.map(r=>r.orderId),[second.id]);
  assert.deepEqual(after.quote.seconds,[240,300]);
  console.log(JSON.stringify({accepted:before.orders.length,before:before.quote.seconds,after:after.quote.seconds}));
} finally {
  await service.dispose(); await rm(dir,{recursive:true,force:true});
}
