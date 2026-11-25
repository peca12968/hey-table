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
const restockReceiptColumns="date,dish,revision,quantity,previous_capacity AS previousCapacity,used,capacity,restocked_at AS restockedAt";
const historyPageSize=25;

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
    db.prepare(`SELECT ${restockReceiptColumns} FROM daily_portion_restocks WHERE operation_id=?`).bind(operationId),
  ]);
  const saved=result.results[0];
  return saved?.date===date&&saved.dish===dish&&saved.revision===revision+1&&saved.quantity===quantity?saved:null;
}

export async function restockHistory(db,date,dish,before){
  const {results}=await db.prepare(`SELECT ${restockReceiptColumns} FROM daily_portion_restocks
    WHERE date=? AND dish=?${before===null?"":" AND revision<?"} ORDER BY revision DESC LIMIT ?`)
    .bind(date,dish,...(before===null?[]:[before]),historyPageSize+1).all();
  return historyPage(date,dish,results);
}

function historyPage(date,dish,results){
  const records=results.slice(0,historyPageSize);
  return {date,dish,capturedAt:Date.now(),records,nextBefore:results.length>historyPageSize?records.at(-1).revision:null};
}

export async function portionLimitHistory(db,date,dish,before){
  const cursor=before===null?"":" AND revision<?";
  const args=before===null?[date,dish]:[date,dish,before];
  const {results}=await db.prepare(`SELECT revision,
      CASE WHEN restored_from_revision IS NULL THEN kind ELSE 'restore' END AS kind,previous_capacity AS previousCapacity,capacity,
      source_date AS sourceDate,changed_at AS changedAt,NULL AS quantity,NULL AS used,restored_from_revision AS restoredFromRevision
    FROM daily_portion_limit_changes WHERE date=? AND dish=?${cursor}
    UNION ALL
    SELECT revision,'restock',previous_capacity,capacity,NULL,restocked_at,quantity,used,NULL
    FROM daily_portion_restocks WHERE date=? AND dish=?${cursor}
    ORDER BY revision DESC LIMIT ?`).bind(...args,...args,historyPageSize+1).all();
  return historyPage(date,dish,results.map(({restoredFromRevision,...row})=>
    restoredFromRevision===null?row:{...row,restoredFromRevision}));
}

function applyRecordedLimits(db,actionId){
  return db.prepare(`INSERT INTO daily_portion_limits(date,dish,capacity,revision)
    SELECT date,dish,capacity,revision FROM daily_portion_limit_changes WHERE action_id=?
    ON CONFLICT(date,dish) DO UPDATE SET capacity=excluded.capacity,revision=excluded.revision
    RETURNING dish,capacity,revision`).bind(actionId);
}

export async function changePortionLimit(db,{date,dish,capacity,revision},now){
  const actionId=crypto.randomUUID();
  const [,applied]=await db.batch([
    db.prepare(`INSERT INTO daily_portion_limit_changes(date,dish,revision,action_id,kind,previous_capacity,capacity,changed_at)
      SELECT ?,?,?,?,'manual',limits.capacity,?,? FROM (SELECT 1) AS anchor
      LEFT JOIN daily_portion_limits AS limits ON limits.date=? AND limits.dish=?
      WHERE COALESCE(limits.revision,0)=?`).bind(date,dish,revision+1,actionId,capacity,now,date,dish,revision),
    applyRecordedLimits(db,actionId),
  ]);
  return applied.results[0];
}

export async function restorePortionLimit(db,{date,dish,revision,fromRevision},now){
  const actionId=crypto.randomUUID();
  const [,applied]=await db.batch([
    db.prepare(`WITH original AS (
      SELECT previous_capacity FROM daily_portion_limit_changes WHERE date=? AND dish=? AND revision=?
      UNION ALL
      SELECT previous_capacity FROM daily_portion_restocks WHERE date=? AND dish=? AND revision=?
    )
    INSERT INTO daily_portion_limit_changes(date,dish,revision,action_id,kind,previous_capacity,capacity,
      restored_from_revision,changed_at)
    SELECT limits.date,limits.dish,limits.revision+1,?,'manual',limits.capacity,original.previous_capacity,?,?
    FROM daily_portion_limits AS limits CROSS JOIN original
    WHERE limits.date=? AND limits.dish=? AND limits.revision=? AND limits.capacity IS NOT original.previous_capacity`)
      .bind(date,dish,fromRevision,date,dish,fromRevision,actionId,fromRevision,now,date,dish,revision),
    applyRecordedLimits(db,actionId),
  ]);
  return applied.results[0];
}

export async function copyPortionLimits(db,sourceDate,date,items,now){
  const actionId=crypto.randomUUID();
  const [,applied]=await db.batch([
    db.prepare(`WITH plan AS MATERIALIZED (
    SELECT json_extract(chosen.value,'$.dish') AS dish,
      json_extract(chosen.value,'$.sourceRevision') AS expectedSource,
      json_extract(chosen.value,'$.targetRevision') AS expectedTarget,
      COALESCE(source.revision,0) AS sourceRevision,
      COALESCE(target.revision,0) AS targetRevision,
      source.capacity AS capacity,target.capacity AS previousCapacity
    FROM json_each(?) AS chosen
    LEFT JOIN daily_portion_limits AS source ON source.date=? AND source.dish=json_extract(chosen.value,'$.dish')
    LEFT JOIN daily_portion_limits AS target ON target.date=? AND target.dish=json_extract(chosen.value,'$.dish')
  )
  INSERT INTO daily_portion_limit_changes(date,dish,revision,action_id,kind,previous_capacity,capacity,source_date,changed_at)
    SELECT ?,dish,targetRevision+1,?,'copy',previousCapacity,capacity,?,? FROM plan
    WHERE NOT EXISTS (SELECT 1 FROM plan
      WHERE sourceRevision<>expectedSource OR targetRevision<>expectedTarget OR capacity IS previousCapacity)`)
      .bind(JSON.stringify(items),sourceDate,date,date,actionId,sourceDate,now),
    applyRecordedLimits(db,actionId),
  ]);
  return applied.results;
}
