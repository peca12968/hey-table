import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {applyDemoMigrations} from "../../scripts/apply-demo-migrations.mjs";

const root=fileURLToPath(new URL(".",import.meta.url));
if (!process.argv[2]) throw new Error("Usage: node kitchen-demo.mjs PATH_TO_HEY_TABLE");
const checkout=resolve(process.argv[2]);
const requireSite=createRequire(join(checkout,"package.json"));
const {build}=requireSite("esbuild");
const {Miniflare}=requireSite("miniflare");
const bundle=await build({stdin:{contents:'import {api} from "./server/api.mjs"; export default {fetch:api};',
  resolveDir:checkout},bundle:true,format:"esm",write:false});
const app=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-15",
  d1Databases:["DB"],bindings:{STAFF_KEY:"fixture-kitchen"}});
const dir=await mkdtemp(join(tmpdir(),"prep-sheet-"));
try {
  const db=await app.getD1Database("DB");
  await applyDemoMigrations(db,checkout);
  async function request(path,method="GET",data) {
    const response=await app.dispatchFetch("http://kitchen.test"+path,{method,
      headers:{"Content-Type":"application/json",...(path.startsWith("/api/kitchen")?{Authorization:"Bearer fixture-kitchen"}:{})},
      ...(data?{body:JSON.stringify(data)}:{})});
    const value=await response.json();
    assert.equal(response.status,200,JSON.stringify(value));
    return value;
  }
  const line=(id,qty)=>({id,qty});
  const payload=(items,table=null)=>({token:randomUUID(),mode:table?"table":"pickup",table,note:"",items});
  const place=body=>request("/api/orders","POST",body);
  const move=(id,from,to)=>request("/api/kitchen/status","PATCH",{id,from,to});
  const body=payload([line("katsudon",2)]);
  const [older,retry]=await Promise.all([place(body),place(body)]);
  assert.equal(older.id,retry.id);
  await delay(10);
  const newer=await place(payload([line("katsudon",1),line("oyakodon",2)],"A03"));
  assert.ok(newer.created>older.created);
  for(const status of ["preparing","ready","completed","cancelled"]) {
    const row=await place(payload([line("sencha",4)]));
    if(status==="cancelled") {await move(row.id,"pending","cancelled");continue;}
    await move(row.id,"pending","preparing");
    if(status!=="preparing") await move(row.id,"preparing","ready");
    if(status==="completed") await move(row.id,"ready","completed");
  }
  const book=JSON.parse(await readFile(join(root,"examples/recipes.json"),"utf8"));
  book.dishes.katsudon[1].from_ms=newer.created;
  const recipes=join(dir,"book.json"), orders=join(dir,"kitchen.json");
  await writeFile(recipes,JSON.stringify(book));
  async function sheet(){
    const receipts=await request("/api/kitchen");
    assert.equal(receipts.length,6);
    await writeFile(orders,JSON.stringify(receipts));
    return JSON.parse(execFileSync(process.env.PYTHON||"python",[join(root,"prep.py"),"--orders",orders,
      "--recipes",recipes,"--stock",join(root,"examples/stock.json")],{env:{...process.env,PYTHONUTF8:"1"}}));
  }
  const first=await sheet();
  assert.deepEqual(first.included_orders,[older.id,newer.id]);
  const rice=first.lines.find(line=>line.component==="rice");
  const broth=first.lines.find(line=>line.component==="dashi");
  assert.deepEqual([rice.needed,rice.batches,rice.remaining,broth.needed,broth.batches],[920,2,100,170,1]);
  await move(newer.id,"pending","cancelled");
  const second=await sheet();
  const after=second.lines.find(line=>line.component==="rice");
  assert.deepEqual(second.included_orders,[older.id]);
  assert.deepEqual([after.needed,after.batches,after.remaining],[360,1,260]);
  const current=await request("/api/kitchen/prep");
  await writeFile(orders,JSON.stringify(current.orders));
  const delivery=join(root,"examples/delivery.json"),ledger=join(dir,"inventory.db");
  function python(script,...args){
    return JSON.parse(execFileSync(process.env.PYTHON||"python",[join(root,script),...args],
      {env:{...process.env,PYTHONUTF8:"1"}}));
  }
  const post=(...args)=>python("ledger.py","--db",ledger,"--recipes",recipes,...args);
  post("init");
  post("receive","opening",delivery);
  const forecast=()=>python("prep.py","--orders",orders,"--recipes",recipes,"--ledger",ledger,"--readiness");
  const opening=forecast();
  assert.deepEqual(opening.orders.map(({order_id,status,prep})=>[order_id,status,prep.map(row=>row.component)]),
    [[older.id,"ready",["rice"]]]);
  const cooked=post("make","pot-1","rice","1");
  assert.equal(cooked.movements.rice.balance,400);
  const issued=post("issue",orders,String(older.id));
  assert.deepEqual(post("issue",orders,String(older.id)),issued);
  assert.deepEqual(issued.movements.rice,{unit:"g",delta:-360,balance:40});
  const outstanding=python("prep.py","--orders",orders,"--recipes",recipes,"--ledger",ledger);
  assert.deepEqual(outstanding.included_orders,[]);
  assert.deepEqual(forecast(),{orders:[],remaining_stock:opening.remaining_stock});
  assert.equal(post("history").length,3);
  console.log(JSON.stringify({receipts:6,selected:first.included_orders.length,riceGrams:rice.needed,
    riceBatches:rice.batches,afterCancellation:{riceGrams:after.needed,riceBatches:after.batches},
    ledger:{cookedGrams:400,issuedGrams:360,remainingGrams:40,receipts:3}},null,2));
} finally {
  await app.dispose();
  await rm(dir,{recursive:true,force:true});
}
