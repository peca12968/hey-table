import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {api} from "../server/api.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const fixture=new URL("../examples/receipt-progress.json",import.meta.url);

export async function buildReceiptNoteDemo(){
  const data=JSON.parse(await readFile(fixture,"utf8"));
  const table=data.find(row=>row.scenario==="table");
  const sqlite=new DatabaseSync(":memory:");
  const originalNow=Date.now;
  let now=table.statusHistory[0].at;
  try{
    const DB=sqliteD1(sqlite),env={DB,STAFF_KEY:"demo-staff"};
    await applyDemoMigrations(DB,root);
    Date.now=()=>now;
    const token=crypto.randomUUID(),ticket={"X-Ticket":token},staff={Authorization:"Bearer demo-staff"};
    const initial="需要餐具",updated="需要兩副餐具",draft={note:updated,expectedRevision:0};
    const payload={token,mode:"table",table:"A03",note:initial,items:[{id:"sencha",qty:1}]};
    const call=(path,headers={},body,method=body?"PATCH":"GET")=>api(new Request("https://demo.example/api"+path,{
      method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,
    }),env);
    const order=await call("/orders",{},payload,"POST");
    assert.equal(order.status,200);
    const {id}=await order.json();
    const prepare=noteRevision=>call("/kitchen/status",staff,{id,from:"pending",to:"preparing",noteRevision});
    const read=async()=> (await call("/ticket",ticket)).json();
    const before=await read();
    assert.equal(before.note,initial);
    now+=30000;
    const saved=await call("/ticket/note",ticket,draft);
    assert.equal(saved.status,200);
    const first=await saved.json();
    assert.deepEqual(first,{id,note:updated,noteRevision:1,noteUpdatedAt:now});
    const lostReplyRetry=await call("/ticket/note",ticket,draft);
    assert.equal(lostReplyRetry.status,200);
    const replay=await lostReplyRetry.json();
    assert.deepEqual(replay,first);
    const stale=await prepare(0);
    const staleCode=(await stale.json()).code;
    const pending=await read();
    assert.deepEqual([stale.status,staleCode,pending.status],[409,"note_changed","pending"]);
    // The original checkout submission remains replayable after a post-order edit.
    assert.equal((await call("/orders",{},payload,"POST")).status,200);
    now=table.statusHistory[1].at;
    const accepted=await prepare(1);
    const started=await read();
    assert.deepEqual([accepted.status,started.status,started.note],[200,"preparing",updated]);
    const late=await call("/ticket/note",ticket,{note:"需要三副餐具",expectedRevision:1});
    const lateCode=(await late.json()).code;
    assert.deepEqual([late.status,lateCode,(await read()).note],[409,"note_closed",updated]);
    return {
      initial:before.note,
      updated:{note:first.note,revision:first.noteRevision,at:first.noteUpdatedAt},
      replayRevision:replay.noteRevision,
      staleAcceptance:{status:stale.status,code:staleCode,orderStatus:pending.status},
      accepted:{status:accepted.status,orderStatus:started.status},
      closedEdit:{status:late.status,code:lateCode},
    };
  }finally{
    Date.now=originalNow;
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildReceiptNoteDemo(),null,2));
}
