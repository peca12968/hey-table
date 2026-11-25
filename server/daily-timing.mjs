import {pickupSlotDuration} from "../lib/pickup-slots.mjs";
import {payableForKitchen} from "./payment-api.mjs";

const history=`json_each(CASE WHEN json_valid(orders.status_history) THEN orders.status_history ELSE '[]' END) AS event`;
const eventTime=`CASE WHEN json_type(event.value,'$.at') IN ('integer','real')
  THEN json_extract(event.value,'$.at') END`;

// Only recorded transitions contribute timestamps. Older receipts can lack one
// or more boundaries even when their current status is already complete.
function timingRows(db, range, scope) {
  return db.prepare(`WITH events AS (
    SELECT orders.id, orders.created, orders.mode, orders.status, orders.pickup_arrived_at AS arrivedAt,
      json_extract(event.value,'$.from') AS previous,
      json_extract(event.value,'$.status') AS next,
      ${eventTime} AS at
    FROM orders
    LEFT JOIN ${history} ON event.type='object'
    WHERE ${scope}
  )
  SELECT created, mode, status, arrivedAt,
    MIN(CASE WHEN previous='pending' AND next='preparing' THEN at END) AS preparingAt,
    MIN(CASE WHEN previous='preparing' AND next='ready' THEN at END) AS readyAt,
    MIN(CASE WHEN previous='ready' AND next='completed' THEN at END) AS completedAt
  FROM events GROUP BY id, created, mode, status, arrivedAt`).bind(...range);
}

export const dailyTimingRows=(db,range)=>timingRows(db,range,
  "orders.created>=? AND orders.created<? AND orders.status IN ('ready','completed')");

export const arrivalTimingRows=(db,range)=>timingRows(db,range,
  "orders.pickup_arrived_at>=? AND orders.pickup_arrived_at<? AND orders.mode='pickup'");

export const pickupPunctualityRows=(db,range)=>db.prepare(`
  SELECT orders.id, orders.created, orders.status, orders.pickup_slot AS start,
    CASE WHEN orders.status='completed' OR ${payableForKitchen} THEN 1 ELSE 0 END AS payable,
    (SELECT MIN(CASE WHEN event.type='object' THEN
        CASE WHEN json_extract(event.value,'$.from')='preparing' AND json_extract(event.value,'$.status')='ready'
          THEN ${eventTime} END END)
      FROM ${history}) AS readyAt
  FROM orders WHERE orders.mode='pickup' AND orders.pickup_slot>=? AND orders.pickup_slot<?
  ORDER BY orders.pickup_slot, orders.id`).bind(...range);

function measure(start, end, created, capturedAt) {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<created||end<start||end>capturedAt)return null;
  return end-start;
}

function summarize(values, eligible) {
  const sorted=values.filter(value=>value!==null).sort((a,b)=>a-b);
  const samples=sorted.length;
  if(!samples)return {eligible,samples,medianMs:null,p90Ms:null};
  const middle=Math.floor(samples/2);
  const medianMs=samples%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
  return {eligible,samples,medianMs,p90Ms:sorted[Math.ceil(samples*.9)-1]};
}

export function dailyTiming(rows, capturedAt) {
  const report={};
  for(const mode of ["pickup","table"]){
    const channel=rows.filter(row=>row.mode===mode);
    const handedOff=channel.filter(row=>row.status==="completed");
    report[mode]={
      preparation:summarize(channel.map(row=>measure(row.preparingAt,row.readyAt,row.created,capturedAt)),channel.length),
      handoff:summarize(handedOff.map(row=>measure(row.readyAt,row.completedAt,row.created,capturedAt)),handedOff.length),
    };
  }
  return report;
}

export function arrivalTiming(rows, capturedAt) {
  const waits=[],ready=[],preparing=[];
  let reported=0,unknownReadiness=0;
  for(const row of rows){
    const {arrivedAt,completedAt,readyAt,created,status}=row;
    if(measure(arrivedAt,arrivedAt,created,capturedAt)===null)continue;
    reported++;
    if(status!=="completed")continue;
    const wait=measure(arrivedAt,completedAt,created,capturedAt);
    waits.push(wait);
    if(wait===null)continue;
    if(measure(readyAt,completedAt,created,capturedAt)===null)unknownReadiness++;
    else (readyAt<=arrivedAt?ready:preparing).push(wait);
  }
  return {reported,overall:summarize(waits,waits.length),readyAtArrival:summarize(ready,ready.length),
    preparingAtArrival:summarize(preparing,preparing.length),unknownReadiness};
}

const counts=()=>({bookings:0,onTime:0,late:0,overdue:0,waiting:0,unknown:0,awaitingPayment:0,cancelled:0});

function punctualityStatus(row, end, capturedAt){
  if(row.status==="cancelled")return "cancelled";
  if(!row.payable)return "awaitingPayment";
  if(!["ready","completed"].includes(row.status))return capturedAt>end?"overdue":"waiting";
  if(measure(row.readyAt,row.readyAt,row.created,capturedAt)===null)return "unknown";
  return row.readyAt<=end?"onTime":"late";
}

export function pickupPunctuality(rows, capturedAt) {
  const totals=counts(), windows=new Map();
  for(const row of rows){
    if(!Number.isSafeInteger(row.start))continue;
    const end=row.start+pickupSlotDuration;
    if(!windows.has(row.start))windows.set(row.start,{start:row.start,end,...counts(),issues:[]});
    const window=windows.get(row.start), status=punctualityStatus(row,end,capturedAt);
    window.bookings++;
    window[status]++;
    totals.bookings++;
    totals[status]++;
    if(status==="late"||status==="overdue")
      window.issues.push({id:row.id,status,readyAt:status==="late"?row.readyAt:null});
  }
  return {totals,windows:[...windows.values()]};
}
