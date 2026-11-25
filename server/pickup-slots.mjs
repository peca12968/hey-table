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

async function slotAvailability(db,starts,date,now,orderLookup){
  const range=[starts[0]??null,starts.at(-1)??null];
  const [,counts,limits,settings,order]=await db.batch([expirePaymentHolds(db,now),db.prepare(`SELECT pickup_slot,${portions} AS used
    ${activeSlots} AND pickup_slot BETWEEN ? AND ? GROUP BY pickup_slot`).bind(...range),
    db.prepare("SELECT start,capacity,revision FROM pickup_slot_limits WHERE start BETWEEN ? AND ?").bind(...range),
    pickupDaySettings(db,date),...(orderLookup?[orderLookup]:[])]);
  const used=new Map(counts.results.map(row=>[row.pickup_slot,row.used]));
  const configured=new Map(limits.results.map(row=>[row.start,row]));
  const day=settings.results[0],accepting=day?.accepting!==0;
  const slots=starts.map(start=>{
    const limit=configured.get(start),taken=used.get(start)??0;
    const capacity=limit?.capacity??null;
    return {start,end:start+pickupSlotDuration,used:taken,capacity,
      remaining:accepting?Math.max(0,(capacity??pickupSlotCapacity)-taken):0,revision:limit?.revision??0};
  });
  return {accepting,revision:day?.revision??0,slots,order:order?.results[0]};
}

export async function pickupSlotOptions(db,now,day,orderLookup){
  const {slots,accepting,order}=await slotAvailability(db,bookablePickupSlots(now,day),day,now,orderLookup);
  return {order,availability:accepting?{slots:slots.map(({start,end,remaining})=>({start,end,remaining}))}:{slots:[],paused:true}};
}

export async function pickupSlots(db,now,day){
  return (await pickupSlotOptions(db,now,day)).availability;
}

export async function pickupSlotLimits(db,date,now){
  const {slots,accepting,revision}=await slotAvailability(db,pickupSlotsForDay(date),date,now);
  const editable=new Set(editablePickupSlots(date,now));
  return {intake:{accepting,revision,editable:editable.size>0},slots:slots.map(slot=>({...slot,editable:editable.has(slot.start)}))};
}

export async function savePickupSlotLimits(db,capacity,slots){
  const {results}=await db.prepare(`WITH plan AS MATERIALIZED (
    SELECT json_extract(chosen.value,'$.start') AS start,
      json_extract(chosen.value,'$.revision') AS expectedRevision,
      COALESCE(limits.revision,0) AS actualRevision
    FROM json_each(?) AS chosen
    LEFT JOIN pickup_slot_limits AS limits ON limits.start=json_extract(chosen.value,'$.start')
  )
  INSERT INTO pickup_slot_limits(start,capacity,revision)
    SELECT start,?,actualRevision+1 FROM plan
    WHERE NOT EXISTS (SELECT 1 FROM plan WHERE actualRevision<>expectedRevision)
  ON CONFLICT(start) DO UPDATE SET capacity=excluded.capacity,revision=excluded.revision
  RETURNING start,capacity,revision`).bind(JSON.stringify(slots.map(({start,revision})=>({start,revision}))),capacity).all();
  return results.sort((a,b)=>a.start-b.start);
}
