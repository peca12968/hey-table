import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {api} from "../server/api.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const site=fileURLToPath(new URL("../",import.meta.url));

export async function buildPickupPassHandoffDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const DB=sqliteD1(sqlite),env={DB,STAFF_KEY:"demo-staff"};
    await applyDemoMigrations(DB,site);
    const owner=crypto.randomUUID(),first=crypto.randomUUID(),replacement=crypto.randomUUID();
    const staff={Authorization:"Bearer demo-staff"};
    const call=(path,method="GET",headers={},body)=>api(new Request("https://demo.example/api"+path,{
      method,headers:{...headers,...(body===undefined?{}:{"Content-Type":"application/json"})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    }),env);
    const created=await call("/orders","POST",{},{
      token:owner,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],
    });
    assert.equal(created.status,200);
    const {id}=await created.json();
    for(const [from,to] of [["pending","preparing"],["preparing","ready"]]){
      assert.equal((await call("/kitchen/status","PATCH",staff,{id,from,to})).status,200);
    }
    const issue=(pass,revision)=>call("/ticket/pickup-pass","POST",{"X-Ticket":owner},{pass,revision});
    const scan=(pass,revision,method="GET",headers=staff)=>call("/kitchen/pickup-pass-handoff?id="+id,method,
      {...headers,"X-Pickup-Pass":revision+"."+pass},method==="PATCH"?{}:undefined);
    assert.equal((await issue(first,0)).status,200);
    const guest=await scan(first,1,"GET",{});
    const checked=await scan(first,1);
    const firstOrder=await checked.json();
    assert.equal(guest.status,403);
    assert.equal(checked.status,200);
    assert.equal(firstOrder.status,"ready");
    const ownerProof={"X-Ticket":owner},passProof={"X-Pickup-Pass":first};
    const arrival=await call("/pickup-pass/arrival","POST",passProof,{revision:0});
    const initiallyArrived=await arrival.json();
    const correction={revision:0,arrivedAt:initiallyArrived.pickupArrivedAt,operationId:crypto.randomUUID()};
    const withdraw=()=>call("/ticket/arrival","PATCH",ownerProof,correction);
    const corrected=await withdraw(),withdrawal=await corrected.json();
    const stale=await call("/pickup-pass/arrival","POST",passProof,{revision:0});
    const delegateState=await (await call("/pickup-pass","GET",passProof)).json();
    const repeated=await withdraw(),recorded=await repeated.json();
    const retry=await call("/pickup-pass/arrival","POST",passProof,{revision:delegateState.pickupArrivalRevision});
    const afterCorrection=await retry.json();
    assert.deepEqual([arrival.status,corrected.status,stale.status,repeated.status,retry.status],[200,200,409,200,200]);
    assert.equal((await stale.json()).code,"arrival_changed");
    assert.deepEqual(recorded,withdrawal);
    const arrivalState=(stage,response,data)=>({stage,status:response.status,arrived:Number.isSafeInteger(data.pickupArrivedAt),
      revision:data.pickupArrivalRevision??0});
    const arrivalCorrection=[arrivalState("reported",arrival,initiallyArrived),arrivalState("withdrawn",corrected,withdrawal),
      arrivalState("stale",stale,delegateState),{...arrivalState("recovered",repeated,recorded),
        sameWithdrawal:recorded.withdrawal.withdrawnAt===withdrawal.withdrawal.withdrawnAt},
      arrivalState("reportedAgain",retry,afterCorrection)];
    assert.equal((await issue(replacement,1)).status,200);
    const rejected=await scan(first,1,"PATCH");
    const afterRejection=await (await scan(replacement,2)).json();
    assert.equal(rejected.status,409);
    assert.equal(afterRejection.status,"ready");
    const confirmed=await scan(replacement,2,"PATCH");
    const recovered=await scan(replacement,2,"PATCH");
    const original=await confirmed.json(),replay=await recovered.json();
    assert.equal(confirmed.status,200);
    assert.equal(recovered.status,200);
    assert.deepEqual(replay,original);
    const receipt=await (await call("/ticket?progress=1","GET",{"X-Ticket":owner})).json();
    const handoff=receipt.statusHistory.filter(step=>step.status==="completed");
    assert.deepEqual(handoff,[{status:"completed",at:original.completedAt,handoff:"pickup-pass"}]);
    assert.equal((await call("/pickup-pass","GET",{"X-Pickup-Pass":replacement})).status,404);
    const recipient=await call("/pickup-pass?handoff=1","GET",{"X-Pickup-Pass":replacement});
    const completion=await recipient.json();
    assert.equal(recipient.status,200);
    assert.deepEqual(completion,{...original,expiresAt:completion.expiresAt});
    assert.equal((await call("/pickup-pass?handoff=1","GET",{"X-Pickup-Pass":first})).status,404);
    return {format:"hey-table.pickup-pass-handoff-demo.v1",orderId:id,arrivalCorrection,scenes:[
      {stage:"guest",status:guest.status},
      {stage:"verified",status:checked.status,orderStatus:firstOrder.status},
      {stage:"reissued",status:rejected.status,orderStatus:afterRejection.status},
      {stage:"completed",status:confirmed.status,orderStatus:original.status},
      {stage:"recovered",status:recovered.status,orderStatus:replay.status,receiptEvents:handoff.length,
        handoff:handoff[0].handoff,sameCompletion:replay.completedAt===original.completedAt,
        recipient:{status:recipient.status,orderStatus:completion.status,matchesStaffTime:completion.completedAt===original.completedAt}},
    ]};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildPickupPassHandoffDemo(),null,2));
}
