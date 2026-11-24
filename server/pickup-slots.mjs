import {businessDate} from "../lib/business-day.mjs";
import {bookablePickupSlots,pickupPrepLead,pickupSlotCapacity,pickupSlotDuration,pickupSlotsForDay} from "../lib/pickup-slots.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";

const portions="SUM(json_extract(line.value,'$.qty'))";
const activeSlots="FROM orders JOIN json_each(orders.items) AS line WHERE status<>'cancelled'";
export const usedAtPickupSlot=`COALESCE((SELECT ${portions} ${activeSlots} AND pickup_slot=?),0)`;
export const capacityAtPickupSlot=`COALESCE((SELECT capacity FROM pickup_slot_limits WHERE start=?),${pickupSlotCapacity})`;
export const orderPortions=`(SELECT ${portions} FROM json_each(orders.items) AS line)`;
export const pickupChanges=row=>JSON.parse(row.pickup_changes??"[]");
export const canReschedulePickup=(row,now)=>row.mode==="pickup"&&row.status==="pending"&&row.pickup_slot>now+pickupPrepLead;
export function editablePickupSlots(date,now){
  const today=businessDate(now);
  if(date>today)return pickupSlotsForDay(date);
  return date===today?bookablePickupSlots(now):[];
}
export const pickupSlotUsage=(db,start)=>db.prepare(`SELECT ${usedAtPickupSlot} AS used,${capacityAtPickupSlot} AS capacity`).bind(start,start);

async function slotAvailability(db,starts,now){
  if(!starts.length)return [];
  const range=[starts[0],starts.at(-1)];
  const [,counts,limits]=await db.batch([expirePaymentHolds(db,now),db.prepare(`SELECT pickup_slot,${portions} AS used
    ${activeSlots} AND pickup_slot BETWEEN ? AND ? GROUP BY pickup_slot`).bind(...range),
    db.prepare("SELECT start,capacity,revision FROM pickup_slot_limits WHERE start BETWEEN ? AND ?").bind(...range)]);
  const used=new Map(counts.results.map(row=>[row.pickup_slot,row.used]));
  const configured=new Map(limits.results.map(row=>[row.start,row]));
  return starts.map(start=>{
    const limit=configured.get(start),taken=used.get(start)??0;
    const capacity=limit?.capacity??null;
    return {start,end:start+pickupSlotDuration,used:taken,capacity,
      remaining:Math.max(0,(capacity??pickupSlotCapacity)-taken),revision:limit?.revision??0};
  });
}

export async function pickupSlots(db,now){
  const rows=await slotAvailability(db,bookablePickupSlots(now),now);
  return rows.map(({start,end,remaining})=>({start,end,remaining}));
}

export async function pickupSlotLimits(db,date,now){
  const rows=await slotAvailability(db,pickupSlotsForDay(date),now);
  const editable=new Set(editablePickupSlots(date,now));
  return rows.map(slot=>({...slot,editable:editable.has(slot.start)}));
}
