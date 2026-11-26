import {payableForKitchen} from "./payment-api.mjs";

const select="SELECT operation_id,table_no,reviewed,completed_at FROM table_handoff_receipts WHERE operation_id=?";
function receipt(row){
  const orderIds=JSON.parse(row.reviewed).map(([id])=>id);
  return {operationId:row.operation_id,table:row.table_no,orderIds,completed:orderIds.length,completedAt:row.completed_at};
}

export async function readTableHandoff(db,operationId){
  const saved=await db.prepare(select).bind(operationId).first();
  return saved?receipt(saved):null;
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
    db.prepare(select).bind(operationId),
  ]);
  const saved=result.results[0];
  return saved?.table_no===table&&saved.reviewed===reviewed?receipt(saved):null;
}
