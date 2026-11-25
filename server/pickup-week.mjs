import {businessDayRange} from "../lib/business-day.mjs";
import {bookablePickupSlots,pickupBookingDays,pickupSlotCapacity,pickupSlotsForDay} from "../lib/pickup-slots.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";
import {payableForKitchen} from "./payment-api.mjs";
import {orderPortions} from "./pickup-slots.mjs";
import {remainingStationItems} from "./station-work.mjs";

function prepByDate(orders,dateBySlot){
  const result=new Map();
  for(const order of orders){
    const date=dateBySlot.get(order.pickup_slot);
    if(!date)continue;
    const counts=result.get(date)??new Map();
    const items=order.status==="preparing"?remainingStationItems(order):JSON.parse(order.items);
    for(const {id,qty} of items){
      const count=counts.get(id)??{id,pending:0,preparing:0};
      count[order.status]+=qty;
      counts.set(id,count);
    }
    result.set(date,counts);
  }
  return result;
}

export async function pickupWeek(db,capturedAt){
  const dates=pickupBookingDays(capturedAt),first=dates[0],last=dates.at(-1);
  const range=[businessDayRange(first)[0],businessDayRange(last)[1]];
  const [,usage,limits,intake,online,prep]=await db.batch([
    expirePaymentHolds(db,capturedAt),
    db.prepare(`SELECT pickup_slot AS start,COUNT(*) AS bookings,SUM(COALESCE(${orderPortions},0)) AS portions
      FROM orders WHERE mode='pickup' AND pickup_slot>=? AND pickup_slot<? AND status<>'cancelled'
      GROUP BY pickup_slot`).bind(...range),
    db.prepare("SELECT start,capacity FROM pickup_slot_limits WHERE start>=? AND start<?").bind(...range),
    db.prepare("SELECT date FROM pickup_day_intake WHERE date BETWEEN ? AND ? AND accepting=0").bind(first,last),
    db.prepare("SELECT accepting FROM order_intake WHERE mode='pickup'"),
    db.prepare(`SELECT pickup_slot,status,items,station_progress
      FROM orders WHERE mode='pickup' AND pickup_slot>=? AND pickup_slot<?
      AND status IN ('pending','preparing') AND ${payableForKitchen}`).bind(...range),
  ]);
  const booked=new Map(usage.results.map(row=>[row.start,row]));
  const configured=new Map(limits.results.map(row=>[row.start,row.capacity]));
  const paused=new Set(intake.results.map(row=>row.date));
  const windows=dates.map(date=>({date,starts:pickupSlotsForDay(date)}));
  const dateBySlot=new Map(windows.flatMap(({date,starts})=>starts.map(start=>[start,date])));
  const demand=prepByDate(prep.results,dateBySlot);
  const days=windows.map(({date,starts})=>{
    const accepting=!paused.has(date),editable=bookablePickupSlots(capturedAt,date);
    const totals={bookings:0,portions:0,available:0,full:0,closed:0};
    for(const start of starts){
      const row=booked.get(start);
      totals.bookings+=row?.bookings??0;
      totals.portions+=row?.portions??0;
    }
    if(accepting)for(const start of editable){
      const capacity=configured.get(start)??pickupSlotCapacity;
      if(capacity===0)totals.closed++;
      else if((booked.get(start)?.portions??0)>=capacity)totals.full++;
      else totals.available++;
    }
    const prep=Array.from(demand.get(date)?.values()??[]).sort((a,b)=>a.id.localeCompare(b.id));
    return {date,accepting,ended:editable.length===0,...totals,prep};
  });
  return {capturedAt,onlineAccepting:online.results[0]?.accepting!==0,days};
}
