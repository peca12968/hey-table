import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {businessDayRange} from "../lib/business-day.mjs";
import {collectCash} from "../server/cash-receipts.mjs";
import {paymentApi} from "../server/payment-api.mjs";
import {shiftHandoff} from "../server/shift-handoff.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const site=fileURLToPath(new URL("../",import.meta.url));

export async function buildShiftHandoffDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite),date="2026-11-26",range=businessDayRange(date),minute=60_000;
    const slot=Date.parse(date+"T11:30:00+08:00"),opening=slot+15*minute,closing=opening+2*minute;
    await applyDemoMigrations(db,site);
    const insert=sqlite.prepare(`INSERT INTO orders(id,token,mode,status,items,note,total,created,pickup_slot,status_history,
      pickup_arrived_at,payment_method,payment_env) VALUES (?,?,'pickup',?,'[]','',45,?,?,?,?,?,?)`);
    const ready=at=>JSON.stringify([{from:"preparing",status:"ready",at}]);
    insert.run(81,crypto.randomUUID(),"ready",slot-20*minute,slot,ready(slot+2*minute),null,"cash","cash");
    insert.run(82,crypto.randomUUID(),"ready",slot-20*minute,slot,ready(slot+3*minute),slot+4*minute,"cash","cash");
    insert.run(83,crypto.randomUUID(),"completed",slot-30*minute,null,null,null,"cash","cash");
    const token=crypto.randomUUID(),reference="DEMO-SHIFT-HANDOFF",started=range[0]-15*minute;
    insert.run(84,token,"pending",started-1000,null,null,null,"line_pay","demo");
    sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,'demo','pending',?)")
      .run(84,reference,started);
    const before=await shiftHandoff(db,date,range,opening);
    assert.deepEqual([before.pickup.unreported.total,before.pickup.arrived.total,before.payments.total,before.cash.total],[1,1,1,1]);

    sqlite.prepare("UPDATE orders SET pickup_arrived_at=? WHERE id=81").run(opening+minute);
    sqlite.prepare("UPDATE orders SET status='completed' WHERE id=82").run();
    for(const id of [82,83]){
      assert.ok((await collectCash(db,{id,expectedTotal:45,tendered:50,operationId:crypto.randomUUID()},closing)).cash_receipt);
    }
    const path="/api/payments/demo";
    const response=await paymentApi(path,new Request("https://demo.example"+path,{method:"POST",headers:{"X-Ticket":token}}),
      {DB:db,TAPPAY_MODE:"demo"},{ref:reference,outcome:"paid"});
    assert.equal(response.status,200);
    assert.equal((await response.json()).attempt.state,"paid");
    const after=await shiftHandoff(db,date,range,closing);
    assert.deepEqual([after.pickup.unreported.total,after.pickup.arrived.total,after.payments.total,after.cash.total],[0,0,0,0]);
    return {format:"hey-table.shift-handoff-demo.v1",scenes:[{stage:"open",snapshot:before},{stage:"resolved",snapshot:after}]};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildShiftHandoffDemo(),null,2));
