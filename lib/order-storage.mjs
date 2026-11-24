import {tables} from "./menu.mjs";

export const cartKey = table => "he-ri-cart-v1:" + (table ?? "pickup");
const receiptPrefix = "he-ri-receipt-v1:";
const lastReceipt = "he-ri-last";
const receiptLimit = 8;
const receiptToken = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function validReceipt(value) {
  return Number.isSafeInteger(value?.id)&&value.id>0&&Number.isSafeInteger(value.created)&&
    value.created>=0&&value.created<=8640000000000000&&(value.table===null||tables.includes(value.table));
}

function storedReceipts() {
  try {
    return Object.keys(localStorage).filter(key=>key.startsWith(receiptPrefix)).flatMap(key=>{
      const token=key.slice(receiptPrefix.length),value=read(key,null);
      return receiptToken.test(token)&&validReceipt(value)?[{...value,token}]:[];
    }).sort((a,b)=>b.created-a.created||b.id-a.id);
  } catch { return []; }
}

export function recentReceipts() {
  return storedReceipts().slice(0,receiptLimit);
}

export function lastReceiptToken() {
  return read(lastReceipt,null)??recentReceipts()[0]?.token;
}

function rememberReceipt(token, value) {
  if(typeof token!=="string"||!receiptToken.test(token)||!validReceipt(value))return false;
  const {id,table,created}=value;
  save(receiptPrefix+token,{id,table,created});
  try {
    for(const old of storedReceipts().slice(receiptLimit))localStorage.removeItem(receiptPrefix+old.token);
  } catch {}
  return Boolean(read(receiptPrefix+token,null));
}

export function refreshReceiptHistory(token, order) {
  const key=receiptPrefix+token;
  const current=read(key,null);
  if(!current)return read(lastReceipt,null)===token&&rememberReceipt(token,order);
  const tableRevision=order.tableMoves?.length??0;
  if(current.id!==order.id||current.created!==order.created||!validReceipt(order)||
    tableRevision<=(current.tableRevision??0))return false;
  const {id,table,created}=order;
  save(key,{id,table,created,tableRevision});
  return true;
}

export function removeReceipt(token) {
  try {
    if(read(lastReceipt,null)===token)localStorage.removeItem(lastReceipt);
    localStorage.removeItem(receiptPrefix+token);
  } catch {}
}

export function openReceipt(scope, token, order) {
  rememberReceipt(token,order);
  save(lastReceipt, token);
  if (read(scope, {}).draft?.token === token) save(scope, {});
  location.replace("/ticket#" + token);
}

export function pendingCarts() {
  return [null, ...tables].filter(table => Boolean(read(cartKey(table), {}).draft?.token));
}
