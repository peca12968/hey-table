import {quoteReturn,remainingReturnLots,returnLots} from "../modules/receipt-returns/quote.mjs";

const receiptQuery="SELECT id,created,items,total,combo_quote FROM orders WHERE id=?";
const entryColumns="order_id,revision,operation_id,selection,quote,recorded_at";
const byOperation=`SELECT ${entryColumns} FROM return_quote_entries WHERE operation_id=?`;
const byReceipt=`SELECT ${entryColumns} FROM return_quote_entries WHERE order_id=? ORDER BY revision`;
const voidColumns="order_id,revision,target_revision,operation_id,reason,restored_amount,remaining_value,recorded_at";
const voidByOperation=`SELECT ${voidColumns} FROM return_quote_voids WHERE operation_id=?`;
const voidsByReceipt=`SELECT ${voidColumns} FROM return_quote_voids WHERE order_id=? ORDER BY revision`;
const revisionGuard=`MAX(COALESCE((SELECT MAX(revision) FROM return_quote_entries WHERE order_id=?),0),
  COALESCE((SELECT MAX(revision) FROM return_quote_voids WHERE order_id=?),0))=?`;

function receipt(row){
  const items=JSON.parse(row.items).map(({id,name,price,qty})=>({id,name,price,qty}));
  return {id:row.id,created:row.created,items,total:row.total,...(row.combo_quote?{combo:JSON.parse(row.combo_quote)}:{})};
}

function entry(row){
  return {revision:row.revision,recordedAt:row.recorded_at,...JSON.parse(row.quote)};
}

function voidEntry(row){
  return {revision:row.revision,targetRevision:row.target_revision,reason:row.reason,
    restoredAmount:row.restored_amount,remainingValue:row.remaining_value,recordedAt:row.recorded_at};
}

function ledger(records,voids){
  const voided=new Map(voids.map(row=>[row.target_revision,voidEntry(row)]));
  return {revision:Math.max(records.at(-1)?.revision??0,voids.at(-1)?.revision??0),records:records.map(row=>{
    const saved=entry(row),change=voided.get(saved.revision);
    return change?{...saved,voided:change}:saved;
  })};
}

function ledgerReads(db,id){
  return [db.prepare(receiptQuery).bind(id),db.prepare(byReceipt).bind(id),db.prepare(voidsByReceipt).bind(id)];
}

export async function readReturnReceipt(db,id,includeLedger){
  if(!includeLedger){
    const row=await db.prepare(receiptQuery).bind(id).first();
    return row?receipt(row):null;
  }
  const [lookup,history,voids]=await db.batch(ledgerReads(db,id));
  if(!lookup.results.length)return null;
  return {ticket:receipt(lookup.results[0]),ledger:ledger(history.results,voids.results)};
}

export async function recordReturnQuote(db,{id,revision,operationId,items,amount},now){
  const selection=items.map(({id,qty})=>[id,qty]).sort(([a],[b])=>a<b?-1:a>b?1:0);
  const encoded=JSON.stringify(selection);
  function replay(row){
    const saved=entry(row);
    return row.order_id===id&&row.revision===revision+1&&row.selection===encoded&&saved.amount===amount
      ?{kind:"saved",entry:saved}:{kind:"stale"};
  }
  const [lookup,history,voids,retry]=await db.batch([
    ...ledgerReads(db,id),db.prepare(byOperation).bind(operationId),
  ]);
  if(retry.results.length)return replay(retry.results[0]);
  if(!lookup.results.length)return {kind:"missing"};
  const current=ledger(history.results,voids.results);
  if(current.revision!==revision)return {kind:"stale"};
  let quote;
  try{
    const pricing=returnLots(receipt(lookup.results[0]));
    quote=quoteReturn(remainingReturnLots(pricing,current.records),new Map(selection));
  }catch(error){
    return {kind:"invalid",message:error.message};
  }
  if(quote.amount!==amount)return {kind:"stale"};
  // The revision predicate covers every quoted lot. The transaction either appends the whole quote or leaves the ledger intact.
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO return_quote_entries (order_id,revision,operation_id,selection,quote,recorded_at)
      SELECT ?,?,?,?,?,?
      WHERE ${revisionGuard} AND NOT EXISTS (SELECT 1 FROM return_quote_voids WHERE operation_id=?)
      ON CONFLICT DO NOTHING`).bind(id,revision+1,operationId,encoded,JSON.stringify(quote),now,id,id,revision,operationId),
    db.prepare(byOperation).bind(operationId),
  ]);
  return saved.results.length?replay(saved.results[0]):{kind:"stale"};
}

export async function voidReturnQuote(db,{id,revision,targetRevision,operationId,reason},now){
  function replay(row){
    return row.order_id===id&&row.revision===revision+1&&row.target_revision===targetRevision&&row.reason===reason
      ?{kind:"saved",entry:voidEntry(row)}:{kind:"stale"};
  }
  const [lookup,history,voids,retry]=await db.batch([
    ...ledgerReads(db,id),db.prepare(voidByOperation).bind(operationId),
  ]);
  if(retry.results.length)return replay(retry.results[0]);
  if(!lookup.results.length)return {kind:"missing"};
  const current=ledger(history.results,voids.results);
  const target=current.records.find(record=>record.revision===targetRevision);
  if(current.revision!==revision||!target||target.voided)return {kind:"stale"};
  let remaining;
  try{
    const pricing=returnLots(receipt(lookup.results[0]));
    remaining=remainingReturnLots(pricing,current.records.filter(record=>record.revision!==targetRevision)).total;
  }catch(error){return {kind:"invalid",message:error.message};}
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO return_quote_voids (order_id,revision,target_revision,operation_id,reason,restored_amount,remaining_value,recorded_at)
      SELECT ?,?,?,?,?,?,?,?
      WHERE ${revisionGuard} AND NOT EXISTS (SELECT 1 FROM return_quote_entries WHERE operation_id=?)
      ON CONFLICT DO NOTHING`).bind(id,revision+1,targetRevision,operationId,reason,target.amount,remaining,now,id,id,revision,operationId),
    db.prepare(voidByOperation).bind(operationId),
  ]);
  return saved.results.length?replay(saved.results[0]):{kind:"stale"};
}
