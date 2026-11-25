import {payableForKitchen} from "./payment-api.mjs";

export const pickupDelayColumn=`(SELECT json_object('revision',revision,'readyAt',ready_at,'recordedAt',recorded_at)
  FROM pickup_delay_updates WHERE order_id=orders.id ORDER BY revision DESC LIMIT 1) AS pickup_delay`;

const byRevision=`FROM pickup_delay_updates WHERE order_id=orders.id ORDER BY revision DESC LIMIT 1`;

export async function updatePickupDelay(db,{id,revision,operationId,minutes},now){
  const readyAt=minutes===null?null:now+minutes*60_000;
  const [,saved,order]=await db.batch([
    db.prepare(`INSERT INTO pickup_delay_updates(order_id,revision,operation_id,ready_at,recorded_at)
      SELECT orders.id,?,?,?,? FROM orders
      WHERE orders.id=? AND orders.mode='pickup' AND orders.status='preparing' AND ${payableForKitchen}
      AND COALESCE((SELECT revision ${byRevision}),0)=?
      AND (? IS NOT NULL OR (SELECT ready_at ${byRevision}) IS NOT NULL)
      ON CONFLICT(operation_id) DO NOTHING`)
      .bind(revision+1,operationId,readyAt,now,id,revision,readyAt),
    db.prepare(`SELECT order_id AS id,revision,ready_at AS readyAt,recorded_at AS recordedAt
      FROM pickup_delay_updates WHERE operation_id=?`).bind(operationId),
    db.prepare("SELECT id FROM orders WHERE id=?").bind(id),
  ]);
  const row=saved.results[0];
  if(!order.results.length)return null;
  if(!row||row.id!==id||row.revision!==revision+1||
      (row.readyAt===null?null:(row.readyAt-row.recordedAt)/60_000)!==minutes)return false;
  return row;
}
