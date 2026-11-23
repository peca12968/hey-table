// Exercise the pinned restaurant's actual Worker routes against a temporary D1.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const site=resolve(process.argv[2]);
const require=createRequire(join(site,"package.json"));
const {build}=require("esbuild"), {Miniflare}=require("miniflare");
const built=await build({stdin:{contents:'import {api} from "./server/api.mjs"; export default {fetch:api};',
  resolveDir:site},bundle:true,format:"esm",write:false});
const app=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:"2026-05-15",d1Databases:["DB"]});
const temp=await mkdtemp(join(tmpdir(),"return-demo-"));
try {
  const db=await app.getD1Database("DB");
  const migrations=join(site,"drizzle");
  const journal=JSON.parse(await readFile(join(migrations,"meta","_journal.json"),"utf8"));
  for(const {tag} of journal.entries) {
    const sql=await readFile(join(migrations,tag+".sql"),"utf8");
    for(const statement of sql.split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))
      await db.prepare(statement).run();
  }
  const token=randomUUID();
  async function call(path,body,ticketToken=token) {
    const response=await app.dispatchFetch("http://restaurant.test/api/"+path,{
      method:body?"POST":"GET",headers:{"Content-Type":"application/json","X-Ticket":ticketToken},
      ...(body?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,200);
    return response.json();
  }
  await call("orders",{token,mode:"table",table:"A03",note:"",paymentMethod:"px_pay_plus",
    comboVersion:"demo-v1",expectedTotal:345,items:[{id:"oyakodon",qty:1},{id:"gyoza",qty:2},{id:"sencha",qty:1}]});
  const {attempt}=await call("payments/start",{});
  await call("payments/demo",{ref:attempt.ref,outcome:"paid"});
  const ticket=await call("ticket");
  assert.equal(ticket.paymentState,"paid");
  const sample=JSON.parse(await readFile(new URL("./examples/ticket.json",import.meta.url),"utf8"));
  assert.deepEqual({...ticket,created:sample.created},sample);
  const path=join(temp,"ticket.json");
  await writeFile(path,JSON.stringify(ticket));
  function cli(...args) {
    return JSON.parse(execFileSync(process.env.PYTHON || "python",[
      fileURLToPath(new URL("./returns.py",import.meta.url)),join(temp,"local.db"),...args],{encoding:"utf8"}));
  }
  const id=String(ticket.id);
  assert.equal(cli("import",path).total,345);
  assert.equal(cli("preview",id,"gyoza=1").amount,85);
  const first=cli("record",id,"gyoza=1","--expected","85","--request","portion-1");
  assert.deepEqual(cli("record",id,"gyoza=1","--expected","85","--request","portion-1"),first);
  const second=cli("record",id,"gyoza=1","--expected","72","--request","portion-2");
  const rest=cli("record",id,"oyakodon=1","sencha=1","--expected","188","--request","rest");
  assert.equal(rest.remainingValue,0);
  assert.deepEqual(cli("history",id),[first,second,rest]);
  assert.deepEqual(await call("ticket"),ticket);
  const next=randomUUID();
  await call("orders",{token:next,mode:"pickup",note:"",paymentMethod:"line_pay",
    comboVersion:"demo-v1",expectedTotal:620,items:[{id:"katsudon",qty:3},{id:"sencha",qty:1},{id:"gyoza",qty:1}]},next);
  const started=await call("payments/start",{},next);
  await call("payments/demo",{ref:started.attempt.ref,outcome:"paid"},next);
  const pickup=await call("ticket",undefined,next);
  await writeFile(path,JSON.stringify(pickup));
  assert.equal(cli("import",path).total,620);
  const porkPrices=[190,162,159], sources=[null,"pork-tea","pork-gyoza"];
  for(const [index,price] of porkPrices.entries()){
    const part=cli("record",String(pickup.id),"katsudon=1","--request","pork-"+index,"--expected",String(price));
    assert.deepEqual([part.amount,part.lines[0].bundle],[price,sources[index]]);
  }
  const sides=cli("preview",String(pickup.id),"sencha=1","gyoza=1");
  assert.deepEqual([sides.amount,sides.remainingValue],[109,0]);
  assert.deepEqual(await call("ticket",undefined,next),pickup);
  console.log(JSON.stringify({method:ticket.paymentMethod,receiptTotal:ticket.total,
    returnAmounts:[first.amount,second.amount,rest.amount],remaining:rest.remainingValue,paymentState:ticket.paymentState,
    pickup:{method:pickup.paymentMethod,total:pickup.total,porkPrices,remainingSides:sides.amount}}));
} finally {
  await app.dispose();
  await rm(temp,{recursive:true,force:true});
}
