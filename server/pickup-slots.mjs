import {businessDate,businessDayRange} from "../lib/business-day.mjs";
import {bookablePickupSlots,pickupBookingDays,pickupPrepLead,pickupSlotCapacity,pickupSlotDuration,pickupSlotsForDay} from "../lib/pickup-slots.mjs";
import {exceededOrderPortions,exceededPortions} from "./daily-limits.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";

const portions="SUM(json_extract(line.value,'$.qty'))";
const activeSlots="FROM orders JOIN json_each(orders.items) AS line WHERE status<>'cancelled'";
const usedAt=start=>`COALESCE((SELECT ${portions} ${activeSlots} AND pickup_slot=${start}),0)`;
const capacityAt=start=>`COALESCE((SELECT capacity FROM pickup_slot_limits WHERE start=${start}),${pickupSlotCapacity})`;
export const usedAtPickupSlot=usedAt("?");
export const capacityAtPickupSlot=capacityAt("?");
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

function firstFittingSlot(quantity,exclude=""){
  return `SELECT candidate.value FROM json_each(?) AS candidate
    WHERE ${usedAt("candidate.value")}+${quantity}<=${capacityAt("candidate.value")} ${exclude}
    ORDER BY candidate.value LIMIT 1`;
}

function firstSuggestion(days,options){
  const index=options.findIndex(result=>result.results[0]?.start!=null);
  return index===-1?null:{date:days[index],start:options[index].results[0].start};
}

export async function suggestCartPickupSlot(db,now,after,items,staff){
  const days=pickupBookingDays(now).filter(day=>day>after);
  if(!days.length)return null;
  const lines=JSON.stringify(items),count=items.reduce((sum,item)=>sum+item.qty,0);
  const searches=days.map(day=>db.prepare(`SELECT (${firstFittingSlot("?")}) AS start
    WHERE NOT ${pickupDayPaused}
    AND (? OR NOT EXISTS(SELECT 1 FROM order_intake WHERE mode='pickup' AND accepting=0))
    AND NOT EXISTS(SELECT 1 FROM unavailable JOIN json_each(?) AS chosen
      ON unavailable.dish=json_extract(chosen.value,'$.id'))
    AND NOT EXISTS (${exceededPortions})`)
    .bind(JSON.stringify(bookablePickupSlots(now,day)),count,day,Number(staff),lines,lines,day,...businessDayRange(day)));
  const [, ...options]=await db.batch([expirePaymentHolds(db,now),...searches]);
  return firstSuggestion(days,options);
}

export async function suggestPickupSlot(db,now,after,orderKey,ref){
  const days=pickupBookingDays(now).filter(day=>day>after);
  const searches=days.map(day=>{
    const range=businessDayRange(day);
    return db.prepare(`SELECT (${firstFittingSlot(orderPortions,"AND candidate.value<>orders.pickup_slot")}) AS start
    FROM orders WHERE ${orderKey}=? AND mode='pickup' AND status='pending' AND pickup_slot>?
    AND NOT ${pickupDayPaused}
    AND ((pickup_slot>=? AND pickup_slot<?) OR NOT EXISTS (${exceededOrderPortions}))`)
      .bind(JSON.stringify(bookablePickupSlots(now,day)),ref,now+pickupPrepLead,day,...range,day,...range);
  });
  const [,found,...options]=await db.batch([expirePaymentHolds(db,now),
    db.prepare(`SELECT mode,status,pickup_slot FROM orders WHERE ${orderKey}=?`).bind(ref),...searches]);
  return {order:found.results[0],suggestion:firstSuggestion(days,options)};
}

export async function pickupSlotLimits(db,date,now){
  const {slots,accepting,revision}=await slotAvailability(db,pickupSlotsForDay(date),date,now);
  const editable=new Set(editablePickupSlots(date,now));
  return {intake:{accepting,revision,editable:editable.size>0},slots:slots.map(slot=>({...slot,editable:editable.has(slot.start)}))};
}

export async function savePickupSlotLimits(db,date,slots,kind,now,{restoredFromId=null,sourceDate=null}={}){
  const operation=crypto.randomUUID();
  const [,saved]=await db.batch([db.prepare(`WITH plan AS MATERIALIZED (
    SELECT json_extract(chosen.value,'$.start') AS start,
      json_extract(chosen.value,'$.revision') AS expectedRevision,
      CASE WHEN ? IS NULL THEN json_extract(chosen.value,'$.capacity') ELSE source.capacity END AS capacity,
      COALESCE(limits.revision,0) AS actualRevision,limits.capacity AS previousCapacity,
      (? IS NULL OR COALESCE(source.revision,0)=json_extract(chosen.value,'$.sourceRevision')) AS sourceMatches
    FROM json_each(?) AS chosen
    LEFT JOIN pickup_slot_limits AS limits ON limits.start=json_extract(chosen.value,'$.start')
    LEFT JOIN pickup_slot_limits AS source ON source.start=json_extract(chosen.value,'$.sourceStart')
    ORDER BY start
  )
  INSERT INTO pickup_limit_events(operation_id,date,changed_at,kind,restored_from_id,source_date,changes)
    SELECT ?,?,?,?,?,?,json_group_array(json_object('start',start,'previousCapacity',previousCapacity,
      'capacity',capacity,'revision',actualRevision+1)) FROM plan
    HAVING count(*)>0 AND count(*)=sum(actualRevision=expectedRevision AND sourceMatches)
      AND (? IS NULL OR sum(previousCapacity IS NOT capacity)>0)`)
    .bind(sourceDate,sourceDate,JSON.stringify(slots),operation,date,now,kind,restoredFromId,sourceDate,restoredFromId??sourceDate),
  db.prepare(`INSERT INTO pickup_slot_limits(start,capacity,revision)
    SELECT json_extract(chosen.value,'$.start'),json_extract(chosen.value,'$.capacity'),json_extract(chosen.value,'$.revision')
    FROM pickup_limit_events AS event JOIN json_each(event.changes) AS chosen WHERE event.operation_id=?
    ON CONFLICT(start) DO UPDATE SET capacity=excluded.capacity,revision=excluded.revision
    RETURNING start,capacity,revision`).bind(operation)]);
  return saved.results.sort((a,b)=>a.start-b.start);
}

export async function savePickupDay(db,date,accepting,revision,now,restoredFromId=null){
  const operation=crypto.randomUUID();
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO pickup_limit_events(operation_id,date,changed_at,kind,restored_from_id,changes)
      SELECT ?,?,?,'day',?,json_array(json_object('previousAccepting',json(CASE WHEN COALESCE(day.accepting,1)=1 THEN 'true' ELSE 'false' END),
        'accepting',json(CASE WHEN ?=1 THEN 'true' ELSE 'false' END),'revision',?))
      FROM (SELECT 1) LEFT JOIN pickup_day_intake AS day ON day.date=? WHERE COALESCE(day.revision,0)=?
      AND (? IS NULL OR COALESCE(day.accepting,1)<>?)`)
      .bind(operation,date,now,restoredFromId,Number(accepting),revision+1,date,revision,restoredFromId,Number(accepting)),
    db.prepare(`INSERT INTO pickup_day_intake(date,accepting,revision)
      SELECT date,json_extract(changes,'$[0].accepting'),json_extract(changes,'$[0].revision')
      FROM pickup_limit_events WHERE operation_id=?
      ON CONFLICT(date) DO UPDATE SET accepting=excluded.accepting,revision=excluded.revision
      RETURNING revision`).bind(operation),
  ]);
  return saved.results.length>0;
}

export async function pickupLimitHistory(db,date,before){
  const size=25;
  const {results}=await db.prepare(`SELECT id,kind,changed_at AS changedAt,restored_from_id AS restoredFromId,
    source_date AS sourceDate,changes FROM pickup_limit_events
    WHERE date=? ${before===null?"":"AND id<?"} ORDER BY id DESC LIMIT ?`)
    .bind(date,...(before===null?[]:[before]),size+1).all();
  const events=results.slice(0,size).map(({restoredFromId,sourceDate,changes,...event})=>({
    ...event,...(restoredFromId===null?{}:{restoredFromId}),...(sourceDate===null?{}:{sourceDate}),changes:JSON.parse(changes),
  }));
  return {date,events,nextBefore:results.length>size?events.at(-1).id:null};
}

export async function pickupLimitEvent(db,date,id){
  const event=await db.prepare("SELECT kind,changes FROM pickup_limit_events WHERE date=? AND id=?").bind(date,id).first();
  return event?{kind:event.kind,changes:JSON.parse(event.changes)}:null;
}
