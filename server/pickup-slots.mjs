import {bookablePickupSlots,pickupPrepLead,pickupSlotCapacity,pickupSlotDuration} from "../lib/pickup-slots.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";

const portions="SUM(json_extract(line.value,'$.qty'))";
const activeSlots="FROM orders JOIN json_each(orders.items) AS line WHERE status<>'cancelled'";
export const usedAtPickupSlot=`COALESCE((SELECT ${portions} ${activeSlots} AND pickup_slot=?),0)`;
export const orderPortions=`(SELECT ${portions} FROM json_each(orders.items) AS line)`;
export const pickupChanges=row=>JSON.parse(row.pickup_changes??"[]");
export const canReschedulePickup=(row,now)=>row.mode==="pickup"&&row.status==="pending"&&row.pickup_slot>now+pickupPrepLead;

export async function pickupSlots(db,now){
  const starts=bookablePickupSlots(now);
  if(!starts.length)return [];
  const [,counts]=await db.batch([expirePaymentHolds(db,now),db.prepare(`SELECT pickup_slot,${portions} AS used
    ${activeSlots} AND pickup_slot BETWEEN ? AND ? GROUP BY pickup_slot`).bind(starts[0],starts.at(-1))]);
  const used=new Map(counts.results.map(row=>[row.pickup_slot,row.used]));
  return starts.map(start=>({start,end:start+pickupSlotDuration,remaining:Math.max(0,pickupSlotCapacity-(used.get(start)??0))}));
}
