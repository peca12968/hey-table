import {payableForKitchen} from "./payment-api.mjs";

const select="SELECT operation_id,table_no,reviewed,completed_at FROM table_handoff_receipts";
const receiptById=select+" WHERE operation_id=?";
function receipt(row){
  const orderIds=JSON.parse(row.reviewed).map(([id])=>id);
  return {operationId:row.operation_id,table:row.table_no,orderIds,completed:orderIds.length,completedAt:row.completed_at};
}

export async function readTableHandoff(db,operationId){
  const saved=await db.prepare(receiptById).bind(operationId).first();
  return saved?receipt(saved):null;
}

export async function tableHandoffHistory(db,{date,range,table,id,limit,before}){
  const filters=["completed_at>=?","completed_at<?"],params=[...range];
  if(table){filters.push("table_no=?");params.push(table);}
  if(id){
    filters.push("EXISTS (SELECT 1 FROM json_each(reviewed) WHERE json_extract(value,'$[0]')=?)");
    params.push(id);
  }
  const where=" WHERE "+filters.join(" AND ");
  const cursor=before?" AND (completed_at,operation_id)<(?,?)":"";
  const bound=before?[before.completedAt,before.operationId]:[];
  const [totals,page]=await db.batch([
    db.prepare(`SELECT COUNT(*) AS batches,COALESCE(SUM(json_array_length(reviewed)),0) AS orders
      FROM table_handoff_receipts${where}`).bind(...params),
    db.prepare(select+where+cursor+" ORDER BY completed_at DESC,operation_id DESC LIMIT ?").bind(...params,...bound,limit+1),
  ]);
  const batches=page.results.slice(0,limit).map(receipt),last=batches.at(-1);
  return {date,table,id,limit,capturedAt:Date.now(),summary:totals.results[0],batches,
    nextBefore:page.results.length>limit?last.completedAt+"."+last.operationId:null};
}

export async function completeTableHandoff(db,table,orders,operationId,now){
  const reviewed=JSON.stringify(orders.map(({id,tableRevision})=>[id,tableRevision]));
  const writeId=crypto.randomUUID();
  const [,,result]=await db.batch([
    db.prepare(`WITH expected AS (
        SELECT json_extract(value,'$[0]') AS id,json_extract(value,'$[1]') AS revision FROM json_each(?)
      ), ready AS MATERIALIZED (
        SELECT expected.id IS NOT NULL AND expected.revision=COALESCE(json_array_length(table_moves),0)
          AND ${payableForKitchen} AS reviewed
        FROM orders LEFT JOIN expected ON expected.id=orders.id
        WHERE orders.mode='table' AND table_no=? AND status='ready'
      )
      INSERT INTO table_handoff_receipts (operation_id,write_id,table_no,reviewed,completed_at)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM ready)=? AND (SELECT COUNT(*) FROM ready WHERE reviewed)=?
      ON CONFLICT(operation_id) DO NOTHING`).bind(reviewed,table,operationId,writeId,table,reviewed,now,orders.length,orders.length),
    db.prepare(`UPDATE orders SET status='completed',
        status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',
          json_object('from','ready','status','completed','at',?))
      WHERE id IN (
        SELECT json_extract(value,'$[0]') FROM table_handoff_receipts,json_each(reviewed)
        WHERE operation_id=? AND write_id=?
      )`).bind(now,operationId,writeId),
    db.prepare(receiptById).bind(operationId),
  ]);
  const saved=result.results[0];
  return saved?.table_no===table&&saved.reviewed===reviewed?receipt(saved):null;
}
