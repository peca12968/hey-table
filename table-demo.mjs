import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

if(!process.argv[2]) throw new Error("Usage: node table-demo.mjs PATH_TO_HEY_TABLE");
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
  const migration=await readFile(join(checkout,"drizzle/0000_fresh_white_tiger.sql"),"utf8");
  for(const sql of migration.split("--> statement-breakpoint")) await db.prepare(sql.trim()).run();
  const token=randomUUID();
  const order={token,mode:"table",table:"A03",note:"",items:["katsudon","gyoza","edamame"].map(id=>({id,qty:1}))};
  const submitted=await app.dispatchFetch("http://restaurant.test/api/orders",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify(order)});
  assert.equal(submitted.status,200);
  const response=await app.dispatchFetch("http://restaurant.test/api/ticket",{headers:{"X-Ticket":token}});
  assert.equal(response.status,200);
  const receipt=await response.json();
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
}finally{
  await app.dispose();
  await rm(dir,{recursive:true,force:true});
}
