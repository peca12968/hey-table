import {businessDayRange} from "./business-day.mjs";
import {stationLabels} from "./kitchen-timing.mjs";

export const prepOrdersFormat="hey-table.prep-orders.v1";
export const prepReportFormat="hey-table.prep-readiness.v1";
const maxTimestamp=8_640_000_000_000_000;
const stations=["all",...Object.keys(stationLabels)];
const orderStates=["pending","preparing"];
const scopes=["all","remaining"];
const text=(value,max=120)=>typeof value==="string"&&Boolean(value.trim())&&value.length<=max;
const integer=(value,min=1,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const invalid=()=>new Error("無法讀取備料試算報告。請確認使用備料頁下載的試算資料。");
const compareText=(left,right)=>left<right?-1:left>right?1:0;

export function prepOrderSource({date,capturedAt,station,scope,orders}){
  if(typeof date!=="string"||!businessDayRange(date)||!integer(capturedAt,1,maxTimestamp)||
    !stations.includes(station)||!scopes.includes(scope)||!Array.isArray(orders))throw invalid();
  const seen=new Set();
  const canonical=orders.map(order=>{
    const {id,created,status,items}=order??{};
    if(!integer(id)||seen.has(id)||!integer(created,0,maxTimestamp)||!orderStates.includes(status)||
      !Array.isArray(items)||items.length===0)throw invalid();
    seen.add(id);
    const lines=items.map(item=>{
      if(!text(item?.id)||!integer(item.qty))throw invalid();
      return {id:item.id,qty:item.qty};
    }).sort((a,b)=>compareText(a.id,b.id)||a.qty-b.qty);
    return {id,created,status,items:lines};
  }).sort((a,b)=>a.id-b.id);
  return {date,capturedAt,station,scope,orders:canonical};
}

function tally(lines,key,field){
  const portions=new Map();
  for(const line of lines){
    const count=(portions.get(line[key])??0)+line[field];
    if(!integer(count))throw invalid();
    portions.set(line[key],count);
  }
  return portions;
}

function materialRows(rows,shortage){
  if(!Array.isArray(rows))throw invalid();
  const seen=new Set();
  return rows.map(line=>{
    const {component,name,unit,quantity,batches}=line??{};
    if(!text(component)||seen.has(component)||!text(name,240)||
      (shortage?!text(unit,30)||!integer(quantity):!integer(batches)))throw invalid();
    seen.add(component);
    return shortage?{component,name,unit,quantity}:{component,name,batches};
  });
}

export function readPrepReadinessReport(value){
  if(value?.format!==prepReportFormat||!value.source||!Array.isArray(value.orders))throw invalid();
  const source=prepOrderSource(value.source);
  const original=new Map(source.orders.map(order=>[order.id,order])),seen=new Set();
  const orders=value.orders.map(row=>{
    const {order_id,status,portions,missing,prep}=row??{};
    const order=original.get(order_id);
    if(!order||seen.has(order_id)||!Array.isArray(portions)||!portions.length)throw invalid();
    seen.add(order_id);
    for(const item of portions){
      if(!text(item?.dish)||!integer(item.from_ms,0,order.created)||!integer(item.quantity))throw invalid();
    }
    const expected=tally(order.items,"id","qty"),actual=tally(portions,"dish","quantity");
    if(expected.size!==actual.size||[...expected].some(([dish,qty])=>actual.get(dish)!==qty))throw invalid();
    const shortages=materialRows(missing,true),batches=materialRows(prep,false);
    if(status!==(shortages.length?"shortage":"ready")||shortages.length&&batches.length)throw invalid();
    return {order_id,status,missing:shortages,prep:batches};
  }).sort((a,b)=>original.get(a.order_id).created-original.get(b.order_id).created||a.order_id-b.order_id);
  return {source,orders};
}

export function matchesPrepOrderSource(current,imported){
  return current.date===imported.date&&current.scope===imported.scope&&current.station===imported.station&&
    JSON.stringify(current.orders)===JSON.stringify(imported.orders);
}
