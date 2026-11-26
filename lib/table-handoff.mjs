import {tables} from "./menu.mjs";

const operationPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validTableHandoffId=value=>typeof value==="string"&&operationPattern.test(value);

export function tableHandoffReview(table,orders){
  if(!tables.includes(table)||!Array.isArray(orders)||orders.length<2||
    orders.some(order=>!order||!Number.isSafeInteger(order.id)||order.id<1||
      !Number.isSafeInteger(order.tableRevision)||order.tableRevision<0)||
    new Set(orders.map(order=>order.id)).size!==orders.length)return null;
  return orders.map(({id,tableRevision})=>({id,tableRevision})).sort((a,b)=>a.id-b.id);
}
