import {dishes} from "../lib/menu.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";

export const supplyTime="COALESCE(orders.pickup_slot,orders.created)";
const suppliedWithin=`${supplyTime}>=? AND ${supplyTime}<? AND status<>'cancelled'`;
const usedByDish=`SELECT json_extract(line.value,'$.id') AS dish, SUM(json_extract(line.value,'$.qty')) AS used
  FROM orders JOIN json_each(orders.items) AS line
  WHERE ${suppliedWithin}
  GROUP BY json_extract(line.value,'$.id')`;
const usedForLimit=`COALESCE((SELECT SUM(json_extract(line.value,'$.qty'))
  FROM orders JOIN json_each(orders.items) AS line
  WHERE ${suppliedWithin} AND json_extract(line.value,'$.id')=limits.dish),0)`;

const excessFor=items=>`SELECT limits.dish FROM daily_portion_limits AS limits
  JOIN json_each(${items}) AS requested ON json_extract(requested.value,'$.id')=limits.dish
  WHERE limits.date=? AND limits.capacity<json_extract(requested.value,'$.qty')+${usedForLimit}`;

export const exceededPortions=excessFor("?");
export const exceededOrderPortions=excessFor("orders.items");

export function readRemaining(db,date,range) {
  return db.prepare(`SELECT dish, MAX(0,capacity-${usedForLimit}) AS remaining
    FROM daily_portion_limits AS limits WHERE date=? AND capacity IS NOT NULL`).bind(...range,date);
}

export async function dailyLimits(db,date,range) {
  const [,settings,counts]=await db.batch([
    expirePaymentHolds(db,Date.now()),
    db.prepare("SELECT dish,capacity,revision FROM daily_portion_limits WHERE date=?").bind(date),
    db.prepare(usedByDish).bind(...range),
  ]);
  const configured=new Map(settings.results.map(row=>[row.dish,row]));
  const used=new Map(counts.results.map(row=>[row.dish,row.used]));
  return Object.fromEntries(dishes.map(({id})=>{
    const row=configured.get(id);
    return [id,{capacity:row?.capacity??null,revision:row?.revision??0,used:used.get(id)??0}];
  }));
}
