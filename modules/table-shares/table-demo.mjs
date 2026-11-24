import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {splitQuote} from "./split.mjs";

if(!process.argv[2]) throw new Error("Usage: node table-demo.mjs PATH_TO_HEY_TABLE [PATH_TO_COMBO_COUNTER]");
const checkout=resolve(process.argv[2]);
const root=fileURLToPath(new URL(".",import.meta.url));
const requireSite=createRequire(join(checkout,"package.json"));
const {build}=requireSite("esbuild");
const {Miniflare}=requireSite("miniflare");
const bundle=await build({stdin:{contents:'import {api} from "./server/api.mjs"; export default {fetch:api};',
  resolveDir:checkout},bundle:true,format:"esm",write:false});
const app=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-15",
  d1Databases:["DB"]});
const dir=await mkdtemp(join(tmpdir(),"table-shares-"));
try{
  const db=await app.getD1Database("DB");
  const migrations=join(checkout,"drizzle");
  const journal=JSON.parse(await readFile(join(migrations,"meta/_journal.json"),"utf8"));
  for(const {tag} of journal.entries){
    const migration=await readFile(join(migrations,tag+".sql"),"utf8");
    for(const sql of migration.split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))
      await db.prepare(sql).run();
  }
  async function place(items){
    const token=randomUUID();
    const order={token,mode:"table",table:"A03",note:"",items};
    const submitted=await app.dispatchFetch("http://restaurant.test/api/orders",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify(order)});
    assert.equal(submitted.status,200);
    const response=await app.dispatchFetch("http://restaurant.test/api/ticket",{headers:{"X-Ticket":token}});
    assert.equal(response.status,200);
    return response.json();
  }
  const receipt=await place(["katsudon","gyoza","edamame"].map(id=>({id,qty:1})));
  assert.equal(receipt.table,"A03");
  assert.equal(receipt.total,330);
  const input=join(dir,"receipt.json");
  await writeFile(input,JSON.stringify(receipt));
  const result=JSON.parse(execFileSync(process.env.PYTHON||"python",[join(root,"split.py"),input,
    join(root,"examples/shares.json")],{env:{...process.env,PYTHONUTF8:"1"}}));
  assert.equal(result.diners["小安"].pay,260);
  assert.equal(result.diners["小岑"].pay,70);
  for(const line of receipt.items){
    assert.equal(Object.values(result.lines[line.id]).reduce((a,b)=>a+b,0),line.price*line.qty);
  }
  console.log(JSON.stringify(result,null,2));
  if(process.argv[3]){
    const combo=resolve(process.argv[3]);
    const {quoteCombos}=await import(pathToFileURL(join(combo,"quote.mjs")));
    const {dishes}=await import(pathToFileURL(join(checkout,"lib/menu.mjs")));
    const rules=JSON.parse(await readFile(join(combo,"examples/promotions.json"),"utf8"));
    const dinner=await place([{id:"oyakodon",qty:1},{id:"gyoza",qty:2},{id:"sencha",qty:1}]);
    const quote=quoteCombos(dishes,rules,dinner.items);
    assert.equal(dinner.total,385);
    assert.deepEqual(quote,JSON.parse(await readFile(join(root,"examples/combo-quote.json"),"utf8")));
    await writeFile(input,JSON.stringify(quote));
    const weights=join(root,"examples/combo-shares.json");
    const python=JSON.parse(execFileSync(process.env.PYTHON||"python",[join(root,"split.py"),"--combo",input,weights],
      {env:{...process.env,PYTHONUTF8:"1"}}));
    const browser=splitQuote(quote,JSON.parse(await readFile(weights,"utf8")));
    assert.deepEqual(JSON.parse(JSON.stringify(browser)),python);
    assert.deepEqual([python.total,python.diners["小安"].pay,python.diners["小岑"].pay],[345,222,123]);
    console.log(JSON.stringify({original:dinner.total,discount:quote.discount,shared:python},null,2));
  }
}finally{
  await app.dispose();
  await rm(dir,{recursive:true,force:true});
}
