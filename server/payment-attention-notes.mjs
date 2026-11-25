import {paymentAttentionStates} from "../lib/payments.mjs";

const limit=20;
const newest="SELECT id FROM payment_attempts WHERE order_id=orders.id ORDER BY id DESC LIMIT 1";
const columns="note.id,note.state,note.note,note.recorded_at AS recordedAt,attempt.created AS startedAt";

export const latestPaymentAttentionNote=`(SELECT json_object('note',recent.note,'recordedAt',recent.recorded_at)
  FROM payment_attention_notes AS recent WHERE recent.attempt_id=attempt.id ORDER BY recent.id DESC LIMIT 1)`;

export async function readPaymentAttentionNotes(db,id,before){
  const bound=before===undefined?"":" AND note.id<?";
  const [order,history]=await db.batch([
    db.prepare(`SELECT attempt.id AS attemptId,attempt.state,attempt.created AS startedAt
      FROM orders LEFT JOIN payment_attempts AS attempt ON attempt.id=(${newest})
      WHERE orders.id=? AND orders.payment_method<>'cash'`).bind(id),
    db.prepare(`SELECT ${columns}
      FROM payment_attempts AS attempt JOIN payment_attention_notes AS note ON note.attempt_id=attempt.id
      WHERE attempt.order_id=?${bound} ORDER BY note.id DESC LIMIT ?`)
      .bind(id,...(before===undefined?[]:[before]),limit+1),
  ]);
  const current=order.results[0];
  if(!current)return null;
  const notes=history.results.slice(0,limit);
  return {id,target:paymentAttentionStates.includes(current.state)?current:null,notes,
    nextBefore:history.results.length>limit?notes.at(-1).id:null};
}

export async function recordPaymentAttentionNote(db,{id,attemptId,state,note,operationId},now){
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO payment_attention_notes(attempt_id,operation_id,state,note,recorded_at)
      SELECT attempt.id,?,?,?,?
      FROM payment_attempts AS attempt JOIN orders ON orders.id=attempt.order_id
      WHERE orders.id=? AND orders.payment_method<>'cash' AND attempt.id=? AND attempt.state=?
        AND attempt.id=(${newest})
      ON CONFLICT DO NOTHING`).bind(operationId,state,note,now,id,attemptId,state),
    db.prepare(`SELECT ${columns},attempt.order_id AS orderId,attempt.id AS attemptId
      FROM payment_attention_notes AS note JOIN payment_attempts AS attempt ON attempt.id=note.attempt_id
      WHERE note.operation_id=?`).bind(operationId),
  ]);
  const row=saved.results[0];
  if(!row)return null;
  const {orderId,attemptId:savedAttempt,...entry}=row;
  return orderId===id&&savedAttempt===attemptId&&entry.state===state&&entry.note===note?entry:null;
}
