import {businessDate} from "../lib/business-day.mjs";
import {bookablePickupSlots,pickupPrepLead,pickupSlotCapacity,pickupSlotDuration,pickupSlotsForDay} from "../lib/pickup-slots.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";

const portions="SUM(json_extract(line.value,'$.qty'))";
const activeSlots="FROM orders JOIN json_each(orders.items) AS line WHERE status<>'cancelled'";
export const usedAtPickupSlot=`COALESCE((SELECT ${portions} ${activeSlots} AND pickup_slot=?),0)`;
export const capacityAtPickupSlot=`COALESCE((SELECT capacity FROM pickup_slot_limits WHERE start=?),${pickupSlotCapacity})`;
export const pickupDayPaused="EXISTS (SELECT 1 FROM pickup_day_intake WHERE date=? AND accepting=0)";
export const orderPortions=`(SELECT ${portions} FROM json_each(orders.items) AS line)`;
export const pickupChanges=row=>JSON.parse(row.pickup_changes??"[]");
export const canReschedulePickup=(row,now)=>row.mode==="pickup"&&row.status==="pending"&&row.pickup_slot>now+pickupPrepLead;
export function editablePickupSlots(date,now){
  const today=businessDate(now);
  if(date>today)return pickupSlotsForDay(date);
  return date===today?bookablePickupSlots(now):[];
}
export const pickupDaySettings=(db,date)=>db.prepare("SELECT accepting,revision FROM pickup_day_intake WHERE date=?").bind(date);
export const pickupSlotUsage=(db,start,date)=>db.prepare(`SELECT ${usedAtPickupSlot} AS used,${capacityAtPickupSlot} AS capacity,
  ${pickupDayPaused} AS paused`).bind(start,start,date);

async function slotAvailability(db,starts,date,now){
  const range=[starts[0]??null,starts.at(-1)??null];
  const [,counts,limits,settings]=await db.batch([expirePaymentHolds(db,now),db.prepare(`SELECT pickup_slot,${portions} AS used
    ${activeSlots} AND pickup_slot BETWEEN ? AND ? GROUP BY pickup_slot`).bind(...range),
    db.prepare("SELECT start,capacity,revision FROM pickup_slot_limits WHERE start BETWEEN ? AND ?").bind(...range),
    pickupDaySettings(db,date)]);
  const used=new Map(counts.results.map(row=>[row.pickup_slot,row.used]));
  const configured=new Map(limits.results.map(row=>[row.start,row]));
  const day=settings.results[0],accepting=day?.accepting!==0;
  const slots=starts.map(start=>{
    const limit=configured.get(start),taken=used.get(start)??0;
    const capacity=limit?.capacity??null;
    return {start,end:start+pickupSlotDuration,used:taken,capacity,
      remaining:accepting?Math.max(0,(capacity??pickupSlotCapacity)-taken):0,revision:limit?.revision??0};
  });
  return {accepting,revision:day?.revision??0,slots};
}

export async function pickupSlots(db,now,day){
  const {slots,accepting}=await slotAvailability(db,bookablePickupSlots(now,day),day,now);
  return accepting?{slots:slots.map(({start,end,remaining})=>({start,end,remaining}))}:{slots:[],paused:true};
}

export async function pickupSlotLimits(db,date,now){
  const {slots,accepting,revision}=await slotAvailability(db,pickupSlotsForDay(date),date,now);
  const editable=new Set(editablePickupSlots(date,now));
  return {intake:{accepting,revision,editable:editable.size>0},slots:slots.map(slot=>({...slot,editable:editable.has(slot.start)}))};
}
