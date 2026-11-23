import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {quoteCombos} from "./quote.mjs";

if (!process.argv[2]) throw new Error("Usage: node restaurant-demo.mjs PATH_TO_HEY_TABLE");
const site = resolve(process.argv[2]);
const load = createRequire(join(site,"package.json"));
const {build} = load("esbuild"), {Miniflare} = load("miniflare");
const {dishes} = await import(pathToFileURL(join(site,"lib/menu.mjs")));
const fixture = name => readFile(new URL("./examples/"+name+".json",import.meta.url),"utf8").then(JSON.parse);
const [rules, items, menu] = await Promise.all(["promotions","cart","menu"].map(fixture));
assert.deepEqual(dishes.map(({id,name,price})=>({id,name,price})),menu);
const bundle = await build({stdin:{contents:'import {api} from "./server/api.mjs"; export default {fetch:api};',
  resolveDir:site},bundle:true,format:"esm",write:false});
const app = new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-15",d1Databases:["DB"]});
try {
  const db = await app.getD1Database("DB");
  const migrations = join(site,"drizzle");
  const journal = JSON.parse(await readFile(join(migrations,"meta","_journal.json"),"utf8"));
  for (const {tag} of journal.entries) {
    const sql = await readFile(join(migrations,tag+".sql"),"utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean)) await db.prepare(stmt).run();
  }
  const token = randomUUID();
  const res = await app.dispatchFetch("http://restaurant.test/api/orders", {method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({token,mode:"table",table:"A03",
      note:"",items:items.map(line=>({...line,price:1})),paymentMethod:"line_pay",total:4})});
  assert.equal(res.status,200);
  const order = await res.json();
  const ticket = async () => {
    const response = await app.dispatchFetch("http://restaurant.test/api/ticket",{headers:{"X-Ticket":token}});
    assert.equal(response.status,200);
    return response.json();
  };
  const before = await ticket();
  assert.deepEqual([order.id,before.table,before.paymentMethod,before.total],[before.id,"A03","line_pay",490]);
  const quote = quoteCombos(dishes,rules,before.items);
  assert.deepEqual([quote.subtotal,quote.discount,quote.total],[before.total,75,415]);
  assert.deepEqual(await ticket(),before);
  const attempts = await db.prepare("SELECT count(*) AS n FROM payment_attempts").first();
  assert.equal(attempts.n,0);
  console.log(JSON.stringify({table:before.table,restaurantTotal:before.total,quotedTotal:quote.total,
    discount:quote.discount,bundles:quote.bundles.map(b=>b.id),paymentAttempts:attempts.n},null,2));
} finally {
  await app.dispose();
}
