import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {paymentApi} from "../server/payment-api.mjs";
import {paymentAttention} from "../server/payment-attention.mjs";
import {readPaymentAttentionNotes,recordPaymentAttentionNote} from "../server/payment-attention-notes.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const uuid=number=>"00000000-0000-4000-8000-"+String(number).padStart(12,"0");
const site=fileURLToPath(new URL("../",import.meta.url));

export async function buildPaymentAttentionDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite),env={DB:db,TAPPAY_MODE:"demo"};
    await applyDemoMigrations(db,site);
    const orderId=895,token=uuid(orderId),reference="DEMO-LINE-PAY";
    const waitingAt=Date.parse("2026-11-25T00:04:00+08:00");
    const opening=sqlite.prepare(`INSERT INTO orders
      (id,token,mode,note,items,total,created,status,payment_method,payment_env,payment_due_at)
      VALUES (?,?,'pickup','','[]',?,?,?,?,?,?)`);
    const starting=sqlite.prepare(`INSERT INTO payment_attempts
      (id,order_id,reference,merchant,state,created) VALUES (?,?,?,'demo',?,?)`);
    const lineStarted=waitingAt-27*60_000,pxStarted=waitingAt-2*60_000;
    opening.run(orderId,token,45,lineStarted-1000,"pending","line_pay","demo",lineStarted+15*60_000);
    opening.run(896,uuid(896),85,pxStarted-1000,"completed","px_pay_plus","sandbox",pxStarted+15*60_000);
    starting.run(101,orderId,reference,"pending",lineStarted);
    starting.run(102,896,"DEMO-PX-PAY","authorized",pxStarted);

    const scenes=[];
    async function capture(stage,capturedAt){
      const queue=await paymentAttention(env,{},capturedAt);
      const {target,notes,nextBefore}=await readPaymentAttentionNotes(db,orderId);
      assert.equal(nextBefore,null);
      const history={target:target?{state:target.state,startedAt:target.startedAt}:null,
        notes:notes.map(({id,state,note,recordedAt,startedAt})=>({id,state,note,recordedAt,startedAt}))};
      scenes.push({stage,queue,history});
    }
    await capture("waiting",waitingAt);
    const payload={id:orderId,attemptId:101,state:"pending",operationId:uuid(2000),
      note:"已告知顧客稍候，下一班先核對這筆 LINE Pay。"};
    const saved=await recordPaymentAttentionNote(db,payload,waitingAt+60_000);
    assert.equal(saved.note,payload.note);
    await capture("saved",waitingAt+90_000);
    const retried=await recordPaymentAttentionNote(db,payload,waitingAt+120_000);
    assert.deepEqual(retried,saved);
    await capture("retried",waitingAt+150_000);
    const path="/api/payments/demo";
    const response=await paymentApi(path,new Request("https://demo.example"+path,{method:"POST",headers:{"X-Ticket":token}}),
      env,{ref:reference,outcome:"paid"});
    assert.equal(response.status,200);
    assert.equal((await response.json()).attempt.state,"paid");
    await capture("settled",waitingAt+240_000);
    return {format:"hey-table.payment-attention-demo.v1",orderId,scenes};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildPaymentAttentionDemo(),null,2));
}
