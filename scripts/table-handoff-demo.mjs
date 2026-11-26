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

export async function buildTableHandoffDemo(){
  const data=JSON.parse(await readFile(fixture,"utf8"));
  const {statusHistory}=data.find(row=>row.scenario==="table");
  const sqlite=new DatabaseSync(":memory:");
  const originalNow=Date.now,now=statusHistory.at(-1).at;
  try{
    const DB=sqliteD1(sqlite),env={DB,STAFF_KEY:"demo-staff"};
    await applyDemoMigrations(DB,root);
    Date.now=()=>now;
    const staff={Authorization:"Bearer demo-staff"},key=crypto.randomUUID(),table="A03";
    const call=(path,headers=staff,body,method=body?"PATCH":"GET")=>api(new Request("https://demo.example/api"+path,{
      method,headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,
    }),env);
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
    return {table,missingStatus:missing.status,writeStatus:write.status,lookupStatus:found.status,
      replayStatus:repeated.status,receipt,orders:changes};
  }finally{
    Date.now=originalNow;
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildTableHandoffDemo(),null,2));
}
