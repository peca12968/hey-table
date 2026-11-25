import {methods,onlinePaymentEnvironments,paymentAttentionStates} from "./payments.mjs";

export const paymentSummaryFileLimit=64*1024;
const format="hey-table.payment-attention-summary.v1";
const countFields=["orders","pending","authorized","overdue"];
const onlineMethods=Object.keys(methods).filter(method=>method!=="cash");
const filterValues={state:paymentAttentionStates,environment:onlinePaymentEnvironments,method:onlineMethods};
const invalid=()=>new Error("摘要資料不完整，請選擇從待核對付款頁下載的 JSON。");
const empty=()=>({orders:0,amount:"0",pending:0,authorized:0,overdue:0});
const groupKey=group=>group.method+":"+group.environment;

function numbers(row){
  if(!row||countFields.some(key=>!Number.isSafeInteger(row[key])||row[key]<0)||
    typeof row.amount!=="string"||!/^(?:0|-?[1-9]\d{0,25})$/.test(row.amount)||
    row.orders-row.pending!==row.authorized||row.overdue>row.pending)throw invalid();
  const {orders,amount,pending,authorized,overdue}=row;
  return {orders,amount,pending,authorized,overdue};
}

export function readPaymentHandoffSummary(value){
  if(!value||value.format!==format||value.timeZone!=="Asia/Taipei"||!Number.isSafeInteger(value.capturedAt)||
    value.capturedAt<1||value.capturedAt>8_640_000_000_000_000||!Array.isArray(value.groups)||
    value.groups.length>(onlineMethods.length+1)*(onlinePaymentEnvironments.length+1))throw invalid();
  const filters={};
  for(const [name,allowed] of Object.entries(filterValues)){
    const filter=value.filters?.[name];
    if(filter!==null&&!allowed.includes(filter))throw invalid();
    filters[name]=filter;
  }
  const totals=numbers(value.totals),seen=new Set(),counted=empty();
  let summed=0n;
  const groups=value.groups.map(row=>{
    const {method,environment}=row??{};
    const counts=numbers(row);
    if(!counts.orders||method!=="unknown"&&!onlineMethods.includes(method)||
      environment!=="unknown"&&!onlinePaymentEnvironments.includes(environment)||
      filters.method!==null&&filters.method!==method||filters.environment!==null&&filters.environment!==environment||
      filters.state==="pending"&&counts.authorized||filters.state==="authorized"&&counts.pending)throw invalid();
    const key=groupKey({method,environment});
    if(seen.has(key))throw invalid();
    seen.add(key);
    for(const field of countFields){
      counted[field]+=counts[field];
      if(counted[field]>totals[field])throw invalid();
    }
    summed+=BigInt(counts.amount);
    return {method,environment,...counts};
  });
  if(countFields.some(field=>counted[field]!==totals[field])||String(summed)!==totals.amount)throw invalid();
  return {format,timeZone:"Asia/Taipei",capturedAt:value.capturedAt,filters,totals,groups};
}

function change(before,after){
  const result={amount:String(BigInt(after.amount)-BigInt(before.amount))};
  for(const field of countFields)result[field]=after[field]-before[field];
  return result;
}

export function comparePaymentHandoffSummaries(earlier,current){
  if(Object.keys(filterValues).some(name=>earlier.filters[name]!==current.filters[name]))
    return {kind:"filters"};
  if(earlier.capturedAt>current.capturedAt)return {kind:"time"};
  const previous=new Map(earlier.groups.map(group=>[groupKey(group),group]));
  const latest=new Map(current.groups.map(group=>[groupKey(group),group]));
  const keys=[...new Set([...previous.keys(),...latest.keys()])].sort();
  const groups=[];
  for(const key of keys){
    const before=previous.get(key)??empty(),after=latest.get(key)??empty();
    const delta=change(before,after),{method,environment}=latest.get(key)??previous.get(key);
    if(countFields.some(field=>delta[field]!==0)||delta.amount!=="0")groups.push({method,environment,before,after,delta});
  }
  return {kind:"compared",earlierAt:earlier.capturedAt,currentAt:current.capturedAt,
    totals:{before:earlier.totals,after:current.totals,delta:change(earlier.totals,current.totals)},groups};
}
