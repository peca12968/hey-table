import {demoKitchen,stationLabels,stationReview} from "../lib/kitchen-timing.mjs";
import {payableForKitchen} from "./payment-api.mjs";

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
  const {results}=await db.prepare(`SELECT id,table_no,source,note,created,items,station_progress,pickup_slot
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

export async function finishStationBatch(db,station,orders) {
  const reviews=new Map(orders.map(({id,review})=>[id,review]));
  const {results}=await db.prepare(`SELECT id,table_no,pickup_slot,note,items,station_progress
    FROM orders WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...reviews.keys()])).all();
  if(results.length!==orders.length)return 0;
  const expected=[];
  for(const row of results){
    const progress=stationProgress(row),items=progress.groups[station];
    if(!items||stationReview({table:row.table_no,pickupSlot:row.pickup_slot,note:row.note,items})!==reviews.get(row.id))
      return 0;
    expected.push({id:row.id,table:row.table_no,slot:row.pickup_slot,note:row.note,
      items:row.items,group:JSON.stringify(items),initial:JSON.stringify(progress)});
  }
  const at=Date.now(),donePath="$.done."+station,groupPath="$.groups."+station;
  // Freeze eligibility and the next progress for the entire selection before writing any row.
  const {meta}=await db.prepare(`WITH expected AS (
    SELECT value AS snapshot FROM json_each(?)
  ), revised AS MATERIALIZED (
    SELECT orders.id,json_set(COALESCE(station_progress,json_extract(snapshot,'$.initial')),?,CAST(? AS INTEGER)) AS progress
    FROM orders JOIN expected ON orders.id=json_extract(snapshot,'$.id')
    WHERE status='preparing' AND ${payableForKitchen}
      AND table_no IS json_extract(snapshot,'$.table') AND pickup_slot IS json_extract(snapshot,'$.slot')
      AND note IS json_extract(snapshot,'$.note') AND items=json_extract(snapshot,'$.items')
      AND json_extract(COALESCE(station_progress,json_extract(snapshot,'$.initial')),?)=json(json_extract(snapshot,'$.group'))
      AND json_type(station_progress,?) IS NULL
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
  FROM outcomes WHERE orders.id=outcomes.id AND (SELECT COUNT(*) FROM revised)=?`)
    .bind(JSON.stringify(expected),donePath,at,groupPath,donePath,at,orders.length).run();
  return meta.changes;
}
