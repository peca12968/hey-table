import {latestState} from "./payment-api.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";
import {orderPortions,pickupDaySettings} from "./pickup-slots.mjs";
import {pickupSlotDuration} from "../lib/pickup-slots.mjs";
import {canPrepare} from "../lib/payments.mjs";
import {kitchenReadyWait,kitchenStageStartedAt} from "./kitchen-overdue.mjs";

export function pickupFollowUp(row,capturedAt){
  const order={status:row.status,paymentMethod:row.payment_method,paymentState:row.payment_state};
  if(order.status!=="ready"||!canPrepare(order))return null;
  const readyAt=kitchenStageStartedAt(row,"ready"),arrivedAt=row.pickup_arrived_at;
  if(readyAt===null||readyAt>capturedAt)return null;
  if(arrivedAt!==null&&(!Number.isSafeInteger(arrivedAt)||arrivedAt<row.created||arrivedAt>capturedAt))return null;
  const dueAt=arrivedAt===null?Math.max(readyAt+kitchenReadyWait,row.pickup_slot+pickupSlotDuration):
    Math.max(readyAt,arrivedAt)+kitchenReadyWait;
  return capturedAt>=dueAt?{state:arrivedAt===null?"unreported":"arrived",readyAt,dueAt,arrivedAt}:null;
}

export async function pickupRoster(db,date,range,capturedAt,includeFollowUp=false){
  const [,settings,bookings]=await db.batch([
    expirePaymentHolds(db,capturedAt),
    pickupDaySettings(db,date),
    db.prepare(`SELECT id,source,status,pickup_slot,payment_method,COALESCE(${latestState},'unpaid') AS payment_state,
      EXISTS (SELECT 1 FROM cash_receipts WHERE order_id=orders.id) AS cash_collected,
      COALESCE(${orderPortions},0) AS portions${includeFollowUp?",created,status_history,pickup_arrived_at":""} FROM orders
      WHERE mode='pickup' AND pickup_slot>=? AND pickup_slot<? ORDER BY pickup_slot,id`).bind(...range),
  ]);
  const windows=new Map();
  const totals={bookings:0,portions:0,cancelled:0};
  const followUp={unreported:0,arrived:0};
  for(const row of bookings.results){
    let window=windows.get(row.pickup_slot);
    if(!window){
      window={start:row.pickup_slot,portions:0,orders:[]};
      windows.set(row.pickup_slot,window);
    }
    const order={id:row.id,source:row.source==="staff"?"staff":"online",status:row.status,
      paymentMethod:row.payment_method,paymentState:row.payment_state,portions:row.portions,
      ...(row.cash_collected?{cashCollected:true}:{})};
    if(includeFollowUp){
      const review=pickupFollowUp(row,capturedAt);
      if(review){
        order.followUp=review;
        followUp[review.state]++;
      }
    }
    window.orders.push(order);
    if(row.status==="cancelled")totals.cancelled++;
    else{
      totals.bookings++;
      totals.portions+=row.portions;
      window.portions+=row.portions;
    }
  }
  return {date,capturedAt,accepting:settings.results[0]?.accepting!==0,totals,windows:Array.from(windows.values()),
    ...(includeFollowUp?{followUp}:{})};
}
