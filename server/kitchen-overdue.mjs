import {canPrepare} from "../lib/payments.mjs";
import {pickupPrepLead} from "../lib/pickup-slots.mjs";

const minute=60_000;
export const kitchenReadyWait=10*minute;
const limits={pending:5*minute,preparing:15*minute,ready:kitchenReadyWait};
const previousStage={preparing:"pending",ready:"preparing"};

export function kitchenStageStartedAt(row,status){
  try{
    const last=JSON.parse(row.status_history??"[]").at(-1);
    if(last?.status===status&&last.from===previousStage[status]&&Number.isSafeInteger(last.at)&&last.at>=row.created)
      return last.at;
  }catch{/* Old orders may lack usable transition history. */}
  return null;
}

export function kitchenOverdue(row,order,capturedAt){
  const limit=limits[order.status];
  if(!limit||!canPrepare(order))return null;
  let startedAt;
  if(order.status==="pending"){
    startedAt=order.paymentMethod==="cash"?(order.cashPaymentChange?.changedAt??row.created):row.kitchen_payable_at;
  }else{
    startedAt=kitchenStageStartedAt(row,order.status);
  }
  if(!Number.isSafeInteger(startedAt)||startedAt<row.created)return null;
  if(order.pickupSlot!=null&&order.status==="pending")startedAt=Math.max(startedAt,order.pickupSlot-pickupPrepLead);
  if(order.pickupSlot!=null&&order.status==="ready")startedAt=Math.max(startedAt,order.pickupSlot);
  if(startedAt>capturedAt)return null;
  const elapsedMs=capturedAt-startedAt;
  return elapsedMs>=limit?{elapsedMs,overByMs:elapsedMs-limit}:null;
}
