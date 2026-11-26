import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {businessDayRange} from "../lib/business-day.mjs";
import {cashCloseComparison,saveCashClose} from "../server/cash-close-versions.mjs";
import {collectCash,correctCashReceipt,dailyCashReceipts} from "../server/cash-receipts.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const site=fileURLToPath(new URL("../",import.meta.url));

export async function buildCashCloseComparisonDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite),date="2026-11-26",range=businessDayRange(date);
    const base=Date.parse(date+"T19:00:00+08:00"),minute=60_000;
    await applyDemoMigrations(db,site);
    const insert=sqlite.prepare(`INSERT INTO orders(id,token,mode,status,items,note,total,created)
      VALUES (?,?,'pickup','ready','[]','',45,?)`);
    for(const id of [71,72])insert.run(id,crypto.randomUUID(),base-minute);
    const collect=(id,tendered,now)=>collectCash(db,{id,expectedTotal:45,tendered,operationId:crypto.randomUUID()},now);
    async function capture(revision,capturedAt,counted){
      const report=await dailyCashReceipts(db,date,range,capturedAt);
      return saveCashClose(db,{date,revision,capturedAt,operationId:crypto.randomUUID(),
        receiptCount:report.totals.receipts,correctionCount:report.correctionCount??0},range,capturedAt+1000,[200n,-20n,counted]);
    }
    assert.ok((await collect(71,100,base)).cash_receipt);
    assert.equal((await capture(0,base+minute,222n)).revision,1);
    const correction=await correctCashReceipt(db,{id:71,revision:0,operationId:crypto.randomUUID(),
      tendered:80,reason:"確認實收為 80 元"},base+2*minute);
    assert.equal(correction.stored.revision,1);
    assert.ok((await collect(72,50,base+3*minute)).cash_receipt);
    assert.equal((await capture(1,base+4*minute,272n)).revision,2);
    const comparison=await cashCloseComparison(db,date,1,2);
    assert.deepEqual(comparison.receipts.map(row=>[row.orderId,row.kind,row.delta.net]),[[71,"corrected","0"],[72,"added","45"]]);
    assert.deepEqual(comparison.reconciliation.difference,{before:"-3",after:"2",delta:"5"});
    return comparison;
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildCashCloseComparisonDemo(),null,2));
