import {tables} from "./menu.mjs";
import {businessDayRange} from "./business-day.mjs";

const operationPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validTableHandoffId=value=>typeof value==="string"&&operationPattern.test(value);

export function tableHandoffReview(table,orders){
  if(!tables.includes(table)||!Array.isArray(orders)||orders.length<2||
    orders.some(order=>!order||!Number.isSafeInteger(order.id)||order.id<1||
      !Number.isSafeInteger(order.tableRevision)||order.tableRevision<0)||
    new Set(orders.map(order=>order.id)).size!==orders.length)return null;
  return orders.map(({id,tableRevision})=>({id,tableRevision})).sort((a,b)=>a.id-b.id);
}

export function tableHandoffHistoryQuery(params){
  if(["date","table","id","before","limit"].some(key=>params.getAll(key).length>1))return null;
  const date=params.get("date"),range=businessDayRange(date);
  const table=params.get("table")||null,rawId=params.get("id")||null,rawLimit=params.get("limit")??"20";
  const id=rawId?Number(rawId):null,limit=Number(rawLimit),cursor=params.get("before");
  if(!range||(table&&!tables.includes(table))||(rawId&&(!/^\d{1,16}$/.test(rawId)||!Number.isSafeInteger(id)||id<1))||
    !/^\d{1,2}$/.test(rawLimit)||limit<1||limit>50)return null;
  let before=null;
  if(cursor!==null){
    const [time,operation,...extra]=cursor.split(".");
    const completedAt=Number(time);
    if(extra.length||!/^\d{1,16}$/.test(time)||!Number.isSafeInteger(completedAt)||
      completedAt<range[0]||completedAt>=range[1]||!validTableHandoffId(operation))return null;
    before={completedAt,operationId:operation.toLowerCase()};
  }
  return {date,range,table,id,limit,before};
}
