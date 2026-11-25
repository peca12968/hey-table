import {payableForKitchen} from "./payment-api.mjs";

const acknowledgement=`(SELECT acknowledged_at FROM pickup_delay_acknowledgements
  WHERE order_id=delay.order_id AND revision=delay.revision)`;
export const pickupDelayColumn=`(SELECT json_object('revision',delay.revision,'readyAt',delay.ready_at,
  'recordedAt',delay.recorded_at,'acknowledgedAt',${acknowledgement})
  FROM pickup_delay_updates AS delay WHERE delay.order_id=orders.id ORDER BY delay.revision DESC LIMIT 1) AS pickup_delay`;

const byRevision=`FROM pickup_delay_updates WHERE order_id=orders.id ORDER BY revision DESC LIMIT 1`;

const currentDelay=`FROM orders JOIN pickup_delay_updates AS delay ON delay.order_id=orders.id
  WHERE orders.token=? AND delay.revision=? AND orders.mode='pickup' AND orders.status='preparing'
  AND ${payableForKitchen} AND delay.ready_at IS NOT NULL AND delay.revision=(SELECT revision ${byRevision})`;

export async function acknowledgePickupDelay(db,token,revision,now){
  const [,saved,order]=await db.batch([
    db.prepare(`INSERT INTO pickup_delay_acknowledgements(order_id,revision,acknowledged_at)
      SELECT delay.order_id,delay.revision,MAX(?,delay.recorded_at) ${currentDelay}
      ON CONFLICT(order_id,revision) DO NOTHING`).bind(now,token,revision),
    db.prepare(`SELECT ${acknowledgement} AS acknowledgedAt ${currentDelay}`).bind(token,revision),
    db.prepare("SELECT id FROM orders WHERE token=?").bind(token),
  ]);
  if(!order.results.length)return null;
  const acknowledgedAt=saved.results[0]?.acknowledgedAt;
  return acknowledgedAt==null?false:{revision,acknowledgedAt};
}

export async function readPickupDelayHistory(db,id,before){
  const size=10,bounded=before!==undefined;
  const [order,page]=await db.batch([
    db.prepare(`SELECT (SELECT MAX(revision) FROM pickup_delay_updates WHERE order_id=orders.id) AS latest
      FROM orders WHERE id=? AND mode='pickup'`).bind(id),
    db.prepare(`SELECT delay.revision,delay.ready_at AS readyAt,delay.recorded_at AS recordedAt,
      ack.acknowledged_at AS acknowledgedAt
      FROM pickup_delay_updates AS delay LEFT JOIN pickup_delay_acknowledgements AS ack
      ON ack.order_id=delay.order_id AND ack.revision=delay.revision
      WHERE delay.order_id=?${bounded?" AND delay.revision<?":""}
      ORDER BY delay.revision DESC LIMIT ?`).bind(id,...(bounded?[before]:[]),size+1),
  ]);
  if(!order.results.length)return null;
  const updates=page.results.slice(0,size).map(update=>({...update,latest:update.revision===order.results[0].latest}));
  return {id,updates,nextBefore:page.results.length>size?updates.at(-1).revision:null};
}

export function pickupDelayReportRows(db,range,capturedAt){
  const scope="delay.recorded_at>=? AND delay.recorded_at<? AND delay.recorded_at<=? AND orders.mode='pickup'";
  const acknowledgementJoin=`LEFT JOIN pickup_delay_acknowledgements AS ack ON ack.order_id=delay.order_id
    AND ack.revision=delay.revision AND ack.acknowledged_at<=?`;
  const source=`FROM pickup_delay_updates AS delay JOIN orders ON orders.id=delay.order_id ${acknowledgementJoin}
    WHERE ${scope}`;
  return {
    delayTotals:db.prepare(`SELECT COUNT(DISTINCT CASE WHEN delay.ready_at IS NOT NULL THEN delay.order_id END) AS affectedOrders,
      COUNT(delay.ready_at) AS notices, COUNT(CASE WHEN delay.ready_at IS NULL THEN 1 END) AS withdrawals,
      COUNT(CASE WHEN delay.ready_at IS NOT NULL THEN ack.acknowledged_at END) AS acknowledged,
      COUNT(CASE WHEN ack.acknowledged_at>delay.ready_at THEN 1 END) AS acknowledgedAfterEstimate ${source}`)
      .bind(capturedAt,...range,capturedAt),
    overdueDelayOrders:db.prepare(`SELECT delay.order_id AS id,delay.revision,delay.ready_at AS readyAt
      ${source} AND orders.status='preparing' AND ${payableForKitchen} AND delay.ready_at<=?
      AND ack.acknowledged_at IS NULL AND delay.revision=(SELECT revision ${byRevision})
      ORDER BY delay.ready_at,delay.order_id`).bind(capturedAt,...range,capturedAt,capturedAt),
  };
}

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
