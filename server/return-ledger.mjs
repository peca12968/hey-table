import {quoteReturn,remainingReturnLots,returnLots} from "../modules/receipt-returns/quote.mjs";

const receiptQuery="SELECT id,created,items,total,combo_quote FROM orders WHERE id=?";
const entryColumns="order_id,revision,operation_id,selection,quote,recorded_at";
const byOperation=`SELECT ${entryColumns} FROM return_quote_entries WHERE operation_id=?`;
const byReceipt=`SELECT ${entryColumns} FROM return_quote_entries WHERE order_id=? ORDER BY revision`;

function receipt(row){
  const items=JSON.parse(row.items).map(({id,name,price,qty})=>({id,name,price,qty}));
  return {id:row.id,created:row.created,items,total:row.total,...(row.combo_quote?{combo:JSON.parse(row.combo_quote)}:{})};
}

function entry(row){
  return {revision:row.revision,recordedAt:row.recorded_at,...JSON.parse(row.quote)};
}

export async function readReturnReceipt(db,id,includeLedger){
  const query=db.prepare(receiptQuery).bind(id);
  if(!includeLedger){
    const row=await query.first();
    return row?receipt(row):null;
  }
  const [lookup,history]=await db.batch([query,db.prepare(byReceipt).bind(id)]);
  if(!lookup.results.length)return null;
  const records=history.results.map(entry);
  return {ticket:receipt(lookup.results[0]),ledger:{revision:records.at(-1)?.revision??0,records}};
}

export async function recordReturnQuote(db,{id,revision,operationId,items,amount},now){
  const selection=items.map(({id,qty})=>[id,qty]).sort(([a],[b])=>a<b?-1:a>b?1:0);
  const encoded=JSON.stringify(selection);
  function replay(row){
    const saved=entry(row);
    return row.order_id===id&&row.revision===revision+1&&row.selection===encoded&&saved.amount===amount
      ?{kind:"saved",entry:saved}:{kind:"stale"};
  }
  const [lookup,history,retry]=await db.batch([
    db.prepare(receiptQuery).bind(id),db.prepare(byReceipt).bind(id),db.prepare(byOperation).bind(operationId),
  ]);
  if(retry.results.length)return replay(retry.results[0]);
  if(!lookup.results.length)return {kind:"missing"};
  const records=history.results;
  if((records.at(-1)?.revision??0)!==revision)return {kind:"stale"};
  let quote;
  try{
    const pricing=returnLots(receipt(lookup.results[0]));
    quote=quoteReturn(remainingReturnLots(pricing,records.map(entry)),new Map(selection));
  }catch(error){
    return {kind:"invalid",message:error.message};
  }
  if(quote.amount!==amount)return {kind:"stale"};
  // The revision predicate covers every quoted lot. The transaction either appends the whole quote or leaves the ledger intact.
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO return_quote_entries (order_id,revision,operation_id,selection,quote,recorded_at)
      SELECT ?,?,?,?,?,?
      WHERE COALESCE((SELECT MAX(revision) FROM return_quote_entries WHERE order_id=?),0)=?
      ON CONFLICT DO NOTHING`).bind(id,revision+1,operationId,encoded,JSON.stringify(quote),now,id,revision),
    db.prepare(byOperation).bind(operationId),
  ]);
  return saved.results.length?replay(saved.results[0]):{kind:"stale"};
}
