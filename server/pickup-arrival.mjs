import {payableForKitchen} from "./payment-api.mjs";

const orderScope="FROM orders WHERE orders.token=?";
const eligible=`orders.mode='pickup' AND orders.status IN ('preparing','ready') AND ${payableForKitchen}`;
export const pickupArrivalColumns=`orders.id,orders.pickup_arrived_at AS pickupArrivedAt,
  orders.pickup_arrival_revision AS pickupArrivalRevision`;
export const latestPickupArrivalWithdrawal=`(SELECT json_object('previousArrivedAt',previous_arrived_at,'withdrawnAt',withdrawn_at)
  FROM pickup_arrival_withdrawals WHERE order_id=orders.id ORDER BY revision DESC LIMIT 1) AS pickup_arrival_withdrawal`;

function withdrawalLookup(db,token,operationId){
  return db.prepare(`SELECT ${pickupArrivalColumns},orders.mode,(${eligible}) AS eligible,
    CASE WHEN withdrawals.revision IS NOT NULL THEN json_object('revision',withdrawals.revision,
      'previousArrivedAt',withdrawals.previous_arrived_at,'withdrawnAt',withdrawals.withdrawn_at) END AS saved
    FROM orders LEFT JOIN pickup_arrival_withdrawals AS withdrawals
    ON withdrawals.order_id=orders.id AND withdrawals.operation_id=?
    WHERE orders.token=?`).bind(operationId,token);
}

function withdrawalState(row){
  const {eligible,mode,saved,...arrival}=row;
  return {...arrival,canWithdraw:Boolean(eligible&&arrival.pickupArrivedAt!==null),withdrawal:saved?JSON.parse(saved):null};
}

export async function readPickupArrivalWithdrawal(db,token,operationId){
  const row=await withdrawalLookup(db,token,operationId).first();
  return row?.mode==="pickup"?withdrawalState(row):null;
}

export function pickupArrivalProjection(row){
  const {pickupArrivalRevision,...details}=row;
  return pickupArrivalRevision>0?{...details,pickupArrivalRevision}:details;
}

export async function reportPickupArrival(db,token,revision,now){
  const [,lookup]=await db.batch([
    db.prepare(`UPDATE orders SET pickup_arrived_at=? WHERE token=? AND ${eligible}
      AND pickup_arrived_at IS NULL AND pickup_arrival_revision=?`).bind(now,token,revision),
    db.prepare(`SELECT ${pickupArrivalColumns} ${orderScope}`).bind(token),
  ]);
  return lookup.results[0]??null;
}

export async function withdrawPickupArrival(db,token,{revision,arrivedAt,operationId},now){
  const [,,current]=await db.batch([
    db.prepare(`INSERT INTO pickup_arrival_withdrawals(order_id,revision,operation_id,previous_arrived_at,withdrawn_at)
      SELECT id,?,?,pickup_arrived_at,MAX(?,pickup_arrived_at) ${orderScope} AND ${eligible}
      AND pickup_arrival_revision=? AND pickup_arrived_at=?
      ON CONFLICT(order_id,operation_id) DO NOTHING`).bind(revision+1,operationId,now,token,revision,arrivedAt),
    db.prepare(`UPDATE orders SET pickup_arrived_at=NULL,pickup_arrival_revision=pickup_arrival_revision+1
      WHERE token=? AND pickup_arrival_revision=? AND pickup_arrived_at=? AND EXISTS (
        SELECT 1 FROM pickup_arrival_withdrawals WHERE order_id=orders.id AND revision=? AND operation_id=?
      )`).bind(token,revision,arrivedAt,revision+1,operationId),
    withdrawalLookup(db,token,operationId),
  ]);
  const row=current.results[0];
  if(!row)return null;
  const {canWithdraw,withdrawal,...arrival}=withdrawalState(row);
  if(withdrawal?.revision!==revision+1||withdrawal.previousArrivedAt!==arrivedAt)return false;
  return {...arrival,withdrawal};
}
