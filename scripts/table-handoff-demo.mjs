import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {api} from "../server/api.mjs";
import {businessDate} from "../lib/business-day.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const fixture=new URL("../examples/receipt-progress.json",import.meta.url);

export async function buildTableHandoffDemo(){
  const data=JSON.parse(await readFile(fixture,"utf8"));
  const {statusHistory}=data.find(row=>row.scenario==="table");
  const sqlite=new DatabaseSync(":memory:");
  const originalNow=Date.now;
  let now=statusHistory.at(-1).at;
  try{
    const DB=sqliteD1(sqlite),env={DB,STAFF_KEY:"demo-staff"};
    await applyDemoMigrations(DB,root);
    Date.now=()=>now;
    const staff={Authorization:"Bearer demo-staff"},key=crypto.randomUUID(),table="A03";
    const call=(path,headers=staff,body,method=body?"PATCH":"GET")=>api(new Request("https://demo.example/api"+path,{
      method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,
    }),env);
    async function readyOrders(table){
      const members=[];
      for(const dish of ["sencha","edamame"]){
        const token=crypto.randomUUID();
        const created=await call("/orders",{},{token,mode:"table",table,note:"",items:[{id:dish,qty:1}]},"POST");
        assert.equal(created.status,200);
        const {id}=await created.json();
        members.push({id,token});
        for(const [from,to] of [["pending","preparing"],["preparing","ready"]])
          assert.equal((await call("/kitchen/status",staff,{id,from,to})).status,200);
      }
      return members;
    }
    const members=await readyOrders(table);
    const path="/kitchen/table-handoff",orders=members.map(({id})=>({id,tableRevision:0}));
    const draft={operationId:key,table,orders},lookup=()=>call(path+"?operationId="+key);
    const missing=await lookup();
    assert.equal(missing.status,404);
    const write=await call(path,staff,draft);
    assert.equal(write.status,200);
    const confirmed=await write.json();
    const found=await lookup();
    assert.equal(found.status,200);
    assert.deepEqual(await found.json(),confirmed);
    const repeated=await call(path,staff,{...draft,orders:[...orders].reverse()});
    assert.equal(repeated.status,200);
    assert.deepEqual(await repeated.json(),confirmed);
    const changes=await Promise.all(members.map(async ({id,token})=>{
      const saved=await (await call("/ticket?progress=1",{"X-Ticket":token})).json();
      const handoffs=saved.statusHistory.filter(event=>event.status==="completed");
      assert.deepEqual(handoffs,[{status:"completed",at:confirmed.completedAt}]);
      return {id,handoffCount:handoffs.length,completedAt:handoffs[0].at};
    }));
    const {operationId,...receipt}=confirmed;
    assert.equal(operationId,key);
    now+=60_000;
    const nextTable="A04",nextOrders=await readyOrders(nextTable);
    const nextReceipt=await call(path,staff,{table:nextTable,operationId:crypto.randomUUID(),
      orders:nextOrders.map(({id})=>({id,tableRevision:0}))});
    assert.equal(nextReceipt.status,200);
    const newest=await nextReceipt.json(),date=businessDate(now);
    async function history(params){
      const reply=await call("/kitchen/table-handoff-history?"+new URLSearchParams({date,...params}));
      assert.equal(reply.status,200);
      return reply.json();
    }
    const latest=await history({limit:1});
    assert.deepEqual(latest.batches,[newest]);
    assert.deepEqual(latest.summary,{batches:2,orders:4});
    const older=await history({limit:1,before:latest.nextBefore});
    assert.deepEqual(older.batches,[confirmed]);
    assert.equal(older.nextBefore,null);
    const filtered=await history({table,id:members[0].id});
    assert.deepEqual(filtered.summary,{batches:1,orders:2});
    assert.deepEqual(filtered.batches,[confirmed]);
    const page=({summary,batches})=>({summary,batches:batches.map(({operationId,...data})=>data)});
    return {table,missingStatus:missing.status,writeStatus:write.status,lookupStatus:found.status,
      replayStatus:repeated.status,receipt,orders:changes,
      history:{date,orderFilter:filtered.id,latest:page(latest),older:page(older),filtered:page(filtered)}};
  }finally{
    Date.now=originalNow;
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildTableHandoffDemo(),null,2));
}
