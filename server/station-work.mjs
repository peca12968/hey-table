import {demoKitchen,stationLabels,stationReview,stationReviewDigest} from "../lib/kitchen-timing.mjs";
import {payableForKitchen} from "./payment-api.mjs";
import {currentOrderNote} from "./order-note.mjs";

function stationProgress(row) {
  if(row.station_progress)return JSON.parse(row.station_progress);
  const groups={};
  for(const {id,name,qty,note} of JSON.parse(row.items)){
    const station=demoKitchen.recipes[id]?.station??"other";
    (groups[station]??=[]).push({id,name,qty,...(note?{note}:{})});
  }
  return {groups,done:{}};
}

export function remainingStationItems(row) {
  if(!row.station_progress)return JSON.parse(row.items);
  const {groups,done}=stationProgress(row);
  return Object.entries(groups).flatMap(([station,items])=>Object.hasOwn(done,station)?[]:items);
}

export function recordedStationProgress(row) {
  if(!row.station_progress)return [];
  const {groups,done}=stationProgress(row);
  return Object.keys(groups).map(station=>({station,doneAt:done[station]??null}));
}

export function preparationByStation(rows,orders) {
  const stations=Object.fromEntries(Object.keys(stationLabels).map(key=>[key,{orders:[],remainingOrders:[]}]));
  rows.forEach((row,index)=>{
    const {groups,done}=stationProgress(row.status==="preparing"?row:{items:row.items});
    const assigned=new Map();
    for(const [station,items] of Object.entries(groups)){
      const key=Object.hasOwn(stations,station)?station:"other";
      if(!assigned.has(key))assigned.set(key,{items:[],remaining:[]});
      const portions=items.map(({id,qty})=>({id,qty})),group=assigned.get(key);
      group.items.push(...portions);
      if(!Object.hasOwn(done,station))group.remaining.push(...portions);
    }
    const order=orders[index];
    for(const [key,{items,remaining}] of assigned){
      if(items.length)stations[key].orders.push({...order,items});
      if(remaining.length)stations[key].remainingOrders.push({...order,items:remaining});
    }
  });
  return stations;
}

export async function stationQueue(db,station) {
  const {results}=await db.prepare(`SELECT id,table_no,source,${currentOrderNote} AS note,created,items,station_progress,pickup_slot
    FROM orders WHERE status='preparing' AND ${payableForKitchen} ORDER BY created,id`).all();
  return results.flatMap(row=>{
    const {groups,done}=stationProgress(row);
    if(!Object.hasOwn(groups,station))return [];
    return [{id:row.id,table:row.table_no,note:row.note,created:row.created,items:groups[station],
      ...(row.source==="staff"?{source:row.source}:{}),
      ...(row.pickup_slot!=null?{pickupSlot:row.pickup_slot}:{}),
      doneAt:done[station]??null,doneStations:Object.keys(done).length,stations:Object.keys(groups).length}];
  });
}

export async function finishStation(db,id,station) {
  const row=await db.prepare("SELECT items,station_progress FROM orders WHERE id=?").bind(id).first();
  if(!row)return null;
  const progress=stationProgress(row);
  const initial=JSON.stringify(progress);
  const at=Date.now(),donePath="$.done."+station,groupPath="$.groups."+station;
  const [, , current]=await db.batch([
    db.prepare(`UPDATE orders SET station_progress=json_set(COALESCE(station_progress,?),?,CAST(? AS INTEGER))
      WHERE id=? AND status='preparing' AND ${payableForKitchen}
      AND json_type(COALESCE(station_progress,?),?)='array' AND json_type(station_progress,?) IS NULL`)
      .bind(initial,donePath,at,id,initial,groupPath,donePath),
    db.prepare(`UPDATE orders SET status='ready',
      status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',json_object('from',status,'status','ready','at',?))
      WHERE id=? AND status='preparing' AND ${payableForKitchen} AND json_type(station_progress,?)='integer'
      AND NOT EXISTS (SELECT 1 FROM json_each(orders.station_progress,'$.groups') AS assigned
        WHERE json_type(orders.station_progress,'$.done.'||assigned.key) IS NULL)`).bind(at,id,donePath),
    db.prepare("SELECT status,json_extract(station_progress,?) AS doneAt FROM orders WHERE id=?").bind(donePath,id),
  ]);
  return current.results[0];
}

const batchReceiptColumns="operation_id AS operationId, station, order_ids AS orderIds, recorded_at AS recordedAt";
const batchReceiptSql=`SELECT ${batchReceiptColumns}, fingerprint FROM station_batch_receipts WHERE operation_id=?`;

function batchReceipt({operationId,station,orderIds,recordedAt}){
  const ids=JSON.parse(orderIds);
  return {operationId,station,completed:ids.length,orderIds:ids,recordedAt};
}

export async function readStationBatch(db,operationId) {
  const row=await db.prepare(batchReceiptSql).bind(operationId).first();
  return row?batchReceipt(row):null;
}

export async function stationBatchHistory(db,[start,end],{station,id,before}) {
  const limit=25;
  const clauses=["recorded_at>=?","recorded_at<?"],values=[start,end];
  if(station){clauses.push("station=?");values.push(station);}
  if(id){clauses.push("EXISTS (SELECT 1 FROM json_each(order_ids) WHERE value=?)");values.push(id);}
  if(before){
    clauses.push("(recorded_at,operation_id)<(?,?)");
    values.push(before.at,before.key);
  }
  const {results}=await db.prepare(`SELECT ${batchReceiptColumns} FROM station_batch_receipts
    WHERE ${clauses.join(" AND ")} ORDER BY recorded_at DESC,operation_id DESC LIMIT ?`).bind(...values,limit+1).all();
  const batches=results.slice(0,limit).map(batchReceipt);
  const last=batches.at(-1);
  const nextBefore=results.length>limit?last.recordedAt+":"+last.operationId:null;
  return {batches,nextBefore};
}

export async function finishStationBatch(db,station,orders,operationId) {
  const reviewed=await Promise.all(orders.map(async ({id,review})=>[id,operationId?review:await stationReviewDigest(review)]));
  reviewed.sort(([a],[b])=>a-b);
  const reviews=new Map(reviewed),ids=JSON.stringify([...reviews.keys()]);
  const fingerprint=await stationReviewDigest(JSON.stringify([station,reviewed]));
  const key=operationId??crypto.randomUUID(),writeId=crypto.randomUUID();
  const {results}=await db.prepare(`SELECT id,table_no,pickup_slot,${currentOrderNote} AS note,items,station_progress
    FROM orders WHERE id IN (SELECT value FROM json_each(?))`).bind(ids).all();
  const expected=[];
  for(const row of results){
    const progress=stationProgress(row),items=progress.groups[station];
    if(!items)continue;
    const review=stationReview({table:row.table_no,pickupSlot:row.pickup_slot,note:row.note,items});
    if(await stationReviewDigest(review)!==reviews.get(row.id))continue;
    expected.push({id:row.id,table:row.table_no,slot:row.pickup_slot,note:row.note,
      items:row.items,group:JSON.stringify(items),initial:JSON.stringify(progress)});
  }
  const at=Date.now(),donePath="$.done."+station,groupPath="$.groups."+station;
  const snapshots=JSON.stringify(expected);
  // The receipt claims all reviewed orders in the same transaction as their progress update.
  // Only this transaction's new claim authorizes a write, including on a same-key retry.
  const [,,saved]=await db.batch([
    db.prepare(`WITH expected AS (SELECT value AS snapshot FROM json_each(?))
      INSERT INTO station_batch_receipts (operation_id,write_id,station,fingerprint,order_ids,recorded_at)
      SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*)
        FROM orders JOIN expected ON orders.id=json_extract(snapshot,'$.id')
        WHERE status='preparing' AND ${payableForKitchen}
          AND table_no IS json_extract(snapshot,'$.table') AND pickup_slot IS json_extract(snapshot,'$.slot')
          AND ${currentOrderNote} IS json_extract(snapshot,'$.note') AND items=json_extract(snapshot,'$.items')
          AND json_extract(COALESCE(station_progress,json_extract(snapshot,'$.initial')),?)=json(json_extract(snapshot,'$.group'))
          AND json_type(station_progress,?) IS NULL)=?
      ON CONFLICT(operation_id) DO NOTHING`)
      .bind(snapshots,key,writeId,station,fingerprint,ids,at,groupPath,donePath,orders.length),
    db.prepare(`WITH revised AS MATERIALIZED (
      SELECT orders.id,json_set(COALESCE(station_progress,json_extract(expected.value,'$.initial')),?,CAST(? AS INTEGER)) AS progress
      FROM station_batch_receipts receipt
      JOIN json_each(?) AS expected
      JOIN orders ON orders.id=json_extract(expected.value,'$.id')
      WHERE receipt.operation_id=? AND receipt.write_id=?
    ), outcomes AS (
      SELECT id,progress,NOT EXISTS (
        SELECT 1 FROM json_each(progress,'$.groups') AS assigned
        WHERE json_type(progress,'$.done.'||assigned.key) IS NULL
      ) AS ready FROM revised
    )
    UPDATE orders SET station_progress=outcomes.progress,
      status=CASE WHEN outcomes.ready THEN 'ready' ELSE orders.status END,
      status_history=CASE WHEN outcomes.ready THEN json_insert(COALESCE(status_history,'[]'),'$[#]',
        json_object('from','preparing','status','ready','at',?)) ELSE status_history END
    FROM outcomes WHERE orders.id=outcomes.id`).bind(donePath,at,snapshots,key,writeId,at),
    db.prepare(batchReceiptSql).bind(key),
  ]);
  const row=saved.results[0];
  return row?.fingerprint===fingerprint?batchReceipt(row):null;
}
