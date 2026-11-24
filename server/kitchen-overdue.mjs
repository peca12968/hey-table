import {canPrepare} from "../lib/payments.mjs";

const minute=60_000;
const limits={pending:5*minute,preparing:15*minute,ready:10*minute};
const previousStage={preparing:"pending",ready:"preparing"};

export function kitchenOverdue(row,order,capturedAt){
  const limit=limits[order.status];
  if(!limit||!canPrepare(order))return null;
  let startedAt;
  if(order.status==="pending"){
    startedAt=order.paymentMethod==="cash"?row.created:row.kitchen_payable_at;
  }else{
    try{
      const last=JSON.parse(row.status_history??"[]").at(-1);
      if(last?.status===order.status&&last.from===previousStage[order.status])startedAt=last.at;
    }catch{/* Old orders may lack usable transition history. */}
  }
  if(!Number.isSafeInteger(startedAt)||startedAt<row.created||startedAt>capturedAt)return null;
  const elapsedMs=capturedAt-startedAt;
  return elapsedMs>=limit?{elapsedMs,overByMs:elapsedMs-limit}:null;
}
