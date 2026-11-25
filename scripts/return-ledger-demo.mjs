import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {businessDayRange} from "../lib/business-day.mjs";
import {confirmReturnLedger,readReturnLedgerReview,recordReturnQuote,returnLedgerReport,voidReturnQuote} from "../server/return-ledger.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const operationId=number=>"00000000-0000-4000-8000-"+String(number).padStart(12,"0");
const site=fileURLToPath(new URL("../",import.meta.url));

export async function buildReturnLedgerDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite);
    await applyDemoMigrations(db,site);
    const prior=Date.parse("2026-11-24T19:00:00+08:00");
    const date="2026-11-25",range=businessDayRange(date);
    const morning=Date.parse(date+"T10:00:00+08:00"),afternoon=Date.parse(date+"T14:05:00+08:00");
    const order=sqlite.prepare("INSERT INTO orders(id,token,mode,note,items,total,created) VALUES (?,?,'pickup','',?,?,?)");
    const fixtures=[
      {id:881,dish:"gyoza",name:"海苔柴魚煎餃",price:85,at:prior},
      {id:895,dish:"sencha",name:"日式熱煎茶",price:45,at:morning},
    ];
    for(const {id,dish,name,price,at} of fixtures){
      order.run(id,operationId(id),JSON.stringify([{id:dish,name,price,qty:1}]),price,at-3600000);
      const saved=await recordReturnQuote(db,{id,revision:0,operationId:operationId(id+1000),
        items:[{id:dish,qty:1}],amount:price},at);
      assert.equal(saved.kind,"saved");
    }
    const capturedAt=morning+60_000;
    const early=await returnLedgerReport(db,date,range,capturedAt);
    const review=await confirmReturnLedger(db,{date,capturedAt,fingerprint:early.fingerprint,note:"早班已核對飲品退餐試算。"},
      range,morning+120_000);
    assert.equal(review.fingerprint,early.fingerprint);
    const before={...early,reviews:[review]};
    const corrected=await voidReturnQuote(db,{id:881,revision:1,targetRevision:1,operationId:operationId(3000),
      reason:"撤銷昨晚誤登的煎餃試算"},afternoon);
    assert.equal(corrected.kind,"saved");
    const after=await returnLedgerReport(db,date,range,afternoon+60_000);
    const archived=await readReturnLedgerReview(db,date,early.fingerprint,range);
    assert.equal(archived.kind,"found");
    return {format:"hey-table.return-ledger-demo.v1",before,after,archived:archived.report};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildReturnLedgerDemo(),null,2));
}
