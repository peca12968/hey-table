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

export async function restockPortions(db,{date,dish,revision,quantity,operationId},range,now){
  const [,,,result]=await db.batch([
    expirePaymentHolds(db,now),
    db.prepare(`WITH observed AS (SELECT limits.capacity, ${usedForLimit} AS used
        FROM daily_portion_limits AS limits WHERE date=? AND dish=? AND revision=? AND capacity IS NOT NULL)
      INSERT INTO daily_portion_restocks(date,dish,revision,operation_id,quantity,previous_capacity,used,capacity,restocked_at)
        SELECT ?,?,?,?,?,capacity,used,MAX(capacity,used)+?,? FROM observed WHERE MAX(capacity,used)<=?
        ON CONFLICT DO NOTHING`)
      .bind(...range,date,dish,revision,date,dish,revision+1,operationId,quantity,quantity,now,Number.MAX_SAFE_INTEGER-quantity),
    db.prepare(`UPDATE daily_portion_limits AS limits SET capacity=receipt.capacity, revision=receipt.revision
      FROM daily_portion_restocks AS receipt
      WHERE receipt.operation_id=? AND receipt.date=? AND receipt.dish=? AND receipt.revision=? AND receipt.quantity=?
        AND limits.date=receipt.date AND limits.dish=receipt.dish AND limits.revision=receipt.revision-1`)
      .bind(operationId,date,dish,revision+1,quantity),
    db.prepare(`SELECT date,dish,revision,quantity,previous_capacity AS previousCapacity,used,capacity,restocked_at AS restockedAt
      FROM daily_portion_restocks WHERE operation_id=?`).bind(operationId),
  ]);
  const saved=result.results[0];
  return saved?.date===date&&saved.dish===dish&&saved.revision===revision+1&&saved.quantity===quantity?saved:null;
}
