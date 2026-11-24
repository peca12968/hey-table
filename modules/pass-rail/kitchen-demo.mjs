import assert from "node:assert/strict";
import {execFile,spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {applyDemoMigrations} from "../../scripts/apply-demo-migrations.mjs";

if(!process.argv[2]) throw new Error("Usage: node kitchen-demo.mjs PATH_TO_HEY_TABLE");
const checkout=resolve(process.argv[2]), root=fileURLToPath(new URL(".",import.meta.url));
const requireSite=createRequire(join(checkout,"package.json"));
const {build}=requireSite("esbuild"), {Miniflare}=requireSite("miniflare");
const bundle=await build({stdin:{contents:'import {api} from "./server/api.mjs"; export default {fetch:api};',
  resolveDir:checkout},bundle:true,format:"esm",write:false});
const staffKey=randomUUID();
const app=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-15",
  host:"127.0.0.1",d1Databases:["DB"],bindings:{STAFF_KEY:staffKey}});
const dir=await mkdtemp(join(tmpdir(),"pass-rail-"));
const python=process.env.PYTHON||"python";
const options={cwd:root,env:{...process.env,PYTHONUTF8:"1",HEY_TABLE_STAFF_KEY:staffKey},timeout:20000};
const execute=promisify(execFile);
async function cli(...args){
  const {stdout}=await execute(python,args,options);
  return stdout.trim() ? JSON.parse(stdout) : null;
}
const rail=(...args)=>cli("rail.py","--db",join(dir,"rail.db"),...args);
const workers=[];
try{
  const base=(await app.ready).origin;
  const db=await app.getD1Database("DB");
  await applyDemoMigrations(db,checkout);
  async function call(path,method,body){
    const response=await fetch(base+path,{method,headers:{"Content-Type":"application/json",
      ...(path.startsWith("/api/kitchen")?{Authorization:"Bearer "+staffKey}:{})},body:JSON.stringify(body)});
    assert.equal(response.status,200);return response.json();
  }
  const payload={token:randomUUID(),mode:"table",table:"A03",note:"分兩杯",
    items:[{id:"oyakodon",qty:1},{id:"sencha",qty:2,note:"分開包裝 <熱>"}]};
  const [one,retry]=await Promise.all([call("/api/orders","POST",payload),call("/api/orders","POST",payload)]);
  assert.equal(one.id,retry.id);
  const pull=()=>rail("pull",base,join(root,"examples/routes.json"));
  assert.equal((await pull()).added,0);
  await call("/api/kitchen/status","PATCH",{id:one.id,from:"pending",to:"preparing"});
  assert.equal((await pull()).added,2);
  assert.equal((await pull()).added,0);
  for(const [name,dish,qty] of [["hot","雞肉親子丼",1],["bar","日式熱煎茶",2]]){
    const path=join(dir,name+".db");
    const proc=spawn(python,["station.py","--db",path,"serve",name,"--port","0"],
      {cwd:root,env:options.env,stdio:["ignore","pipe","inherit"],windowsHide:true});
    const ended=once(proc,"exit");
    workers.push({proc,ended});
    const lines=createInterface({input:proc.stdout});
    const first=await Promise.race([once(lines,"line"),ended.then(()=>{throw new Error("Station exited before startup");})]);
    lines.close();
    const {url}=JSON.parse(first[0]);
    const [receipt]=await rail("deliver",name,url);
    assert.equal(receipt.state,"accepted");
    assert.deepEqual(await rail("deliver",name,url),[]);
    const slip=await cli("station.py","--db",path,"list");
    assert.deepEqual(slip.items.map(i=>[i.name,i.qty]),[[dish,qty]]);
    assert.equal(slip.items[0].note,name==="bar"?"分開包裝 <熱>":undefined);
    const html=join(dir,name+".html");
    await cli("station.py","--db",path,"export",receipt.key,html);
    const printed=await readFile(html,"utf8");
    for(const text of ["A03 桌內用","分兩杯",dish]) assert.ok(printed.includes(text));
    assert.equal(printed.includes("分開包裝 &lt;熱&gt;"),name==="bar");
  }
  const stations=await rail("status");
  const late=await call("/api/orders","POST",{...payload,token:randomUUID()});
  const move=(id,from,to)=>call("/api/kitchen/status","PATCH",{id,from,to});
  await move(late.id,"pending","preparing");
  assert.equal((await pull()).added,2);
  await move(late.id,"preparing","ready");
  await move(late.id,"ready","completed");
  for(let n=0;n<20;n++){
    const newer=await call("/api/orders","POST",{...payload,token:randomUUID()});
    await move(newer.id,"pending","cancelled");
  }
  assert.equal((await pull()).skipped,2);
  const expired=(await rail("status")).filter(row=>row.order_id===late.id);
  assert.deepEqual(expired.map(row=>row.state),["skipped","skipped"]);
  console.log(JSON.stringify({order:one.id,stations,archivedOrder:late.id,skipped:expired.length},null,2));
}finally{
  for(const {proc,ended} of workers){if(proc.exitCode===null) proc.kill();await ended;}
  await app.dispose();
  await rm(dir,{recursive:true,force:true});
}
