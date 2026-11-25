import {demoKitchen,stationLabels} from "../lib/kitchen-timing.mjs";
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
