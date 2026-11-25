import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {api} from "../server/api.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const site=fileURLToPath(new URL("../",import.meta.url));

export async function buildCustomerPaymentRecoveryDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite),env={DB:db,TAPPAY_MODE:"demo"};
    await applyDemoMigrations(db,site);
    const count=sqlite.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE order_id=?");
    const scenarios=[];
    for(const [number,kind,method] of [[1,"reached","line_pay"],[2,"notReached","px_pay_plus"]]){
      const token="00000000-0000-4000-8000-"+String(number).padStart(12,"0");
      async function call(path,input){
        const headers={"X-Ticket":token,"Content-Type":"application/json"};
        const response=await api(new Request("https://demo.example/api/"+path,input===undefined?
          {headers}:{method:"POST",headers,body:JSON.stringify(input)}),env);
        assert.equal(response.status,200);
        return response.json();
      }
      const {id:orderId,total}=await call("orders",{token,mode:"pickup",note:"",
        items:[{id:"sencha",qty:1}],paymentMethod:method,paymentEnv:"demo"});
      let clientStarts=0;
      const scenes=[];
      const capture=(stage,paymentState)=>scenes.push({stage,paymentState,clientStarts,
        storedAttempts:paymentState===null?null:count.get(orderId).n});
      const start=async()=>{
        clientStarts++;
        return (await call("payments/start",{})).attempt;
      };
      capture("ready",(await call("ticket")).paymentState);
      let original;
      if(kind==="reached")original=await start();
      else clientStarts++; // The request leaves the demo browser but never reaches the server.
      capture("interrupted",null);

      const checked=await call("payments/check",{});
      if(original)assert.deepEqual(checked.attempt,original);
      else assert.ok(!checked.attempt);
      capture("checked",checked.paymentState);
      const continued=checked.attempt??await start();
      capture("continued",continued.state);

      const {attempt:paid}=await call("payments/demo",{ref:continued.ref,outcome:"paid"});
      assert.equal(paid.ref,continued.ref);
      const receipt=await call("ticket");
      assert.deepEqual([receipt.id,receipt.total,receipt.paymentMethod,receipt.paymentState],[orderId,total,method,"paid"]);
      capture("paid",receipt.paymentState);
      assert.equal(count.get(orderId).n,1);
      scenarios.push({kind,orderId,total,method,scenes});
    }
    return {format:"hey-table.customer-payment-recovery-demo.v1",scenarios};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildCustomerPaymentRecoveryDemo(),null,2));
}
