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

async function lockCart(scope, action) {
  if(!navigator.locks?.request)return action();
  let entered=false;
  try{
    return await navigator.locks.request(scope,()=>{
      entered=true;
      return action();
    });
  }catch(error){
    if(entered||!["SecurityError","InvalidStateError","NotSupportedError"].includes(error.name))throw error;
    return action();
  }
}

export const sameCheckout=(left,right)=>left?.token===right?.token&&left?.state===right?.state;
// Edits are written synchronously under the last checkout version so that a stale
// tab cannot overwrite a newer draft or delay saving an edit until after navigation.
const editKey=(scope,checkout)=>scope+":edit:"+(checkout?checkout.token+":"+checkout.state:"initial");

export function readCart(scope) {
  const current=read(scope,{});
  if(current.draft)return current;
  const edits=read(editKey(scope,current.checkout),null);
  return edits?{...current,...edits}:current;
}

export function dispatchCart(scope, action) {
  return lockCart(scope+":dispatch",action);
}

export function persistCart(scope, record, checkout) {
  const current=read(scope,{});
  if(!record.draft&&!current.draft&&sameCheckout(current.checkout,checkout))
    save(editKey(scope,checkout),record);
}

export function claimCart(scope, record, checkout) {
  return lockCart(scope,()=>{
    const current=readCart(scope);
    if(!sameCheckout(current.checkout,checkout)||(current.draft&&current.draft.token!==record.draft.token))
      return {send:false,record:current};
    save(scope,{...record,...(checkout?{checkout}:{})});
    return {send:true};
  });
}

export function settleCart(scope, token, state) {
  return lockCart(scope,()=>{
    const current=read(scope,{});
    const lateConfirmation=state==="completed"&&!current.draft&&current.checkout?.token===token&&current.checkout.state==="rejected";
    if(current.draft?.token!==token&&!lateConfirmation)return current;
    const checkout={token,state};
    const next=state==="completed"?{checkout}:{...current,checkout,draft:null};
    save(scope,next);
    try{localStorage.removeItem(editKey(scope,current.checkout));}catch{}
    return next;
  });
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

export async function openReceipt(scope, token, order) {
  rememberReceipt(token,order);
  save(lastReceipt, token);
  await settleCart(scope,token,"completed");
  location.replace("/ticket#" + token);
}

export function pendingCarts() {
  return [null, ...tables].filter(table => Boolean(read(cartKey(table), {}).draft?.token));
}
