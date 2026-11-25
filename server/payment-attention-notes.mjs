import {paymentAttentionStates} from "../lib/payments.mjs";

const limit=20;
const newest="SELECT id FROM payment_attempts WHERE order_id=orders.id ORDER BY id DESC LIMIT 1";
const columns="note.id,note.state,note.note,note.recorded_at AS recordedAt,attempt.created AS startedAt,note.follow_up_at AS followUpAt";
export const latestFollowUpId=`SELECT follow.id FROM payment_attention_notes AS follow
  WHERE follow.attempt_id=attempt.id AND follow.follow_up_at IS NOT NULL ORDER BY follow.id DESC LIMIT 1`;
export const paymentFollowUpJoin=`LEFT JOIN payment_attention_notes AS followUp ON followUp.id=(${latestFollowUpId})`;

function formatNote({followUpAt,...entry}){
  return followUpAt===null?entry:{...entry,followUpAt:followUpAt||null};
}

export const latestPaymentAttentionNote=`(SELECT json_object('note',recent.note,'recordedAt',recent.recorded_at)
  FROM payment_attention_notes AS recent WHERE recent.attempt_id=attempt.id ORDER BY recent.id DESC LIMIT 1)`;

export async function readPaymentAttentionNotes(db,id,before,attemptId){
  const bound=before===undefined?"":" AND note.id<?";
  const selected=attemptId===undefined?"":" AND attempt.id=?";
  const belongs=attemptId===undefined?"":" AND EXISTS (SELECT 1 FROM payment_attempts WHERE order_id=orders.id AND id=?)";
  const attemptArgs=attemptId===undefined?[]:[attemptId];
  const [order,history]=await db.batch([
    db.prepare(`SELECT attempt.id AS attemptId,attempt.state,attempt.created AS startedAt,
      followUp.id AS followUpVersion,NULLIF(followUp.follow_up_at,0) AS followUpAt
      FROM orders LEFT JOIN payment_attempts AS attempt ON attempt.id=(${newest})
      ${paymentFollowUpJoin}
      WHERE orders.id=? AND orders.payment_method<>'cash'${belongs}`).bind(id,...attemptArgs),
    db.prepare(`SELECT ${columns}
      FROM payment_attempts AS attempt JOIN payment_attention_notes AS note ON note.attempt_id=attempt.id
      WHERE attempt.order_id=?${selected}${bound} ORDER BY note.id DESC LIMIT ?`)
      .bind(id,...attemptArgs,...(before===undefined?[]:[before]),limit+1),
  ]);
  if(!order.results.length)return null;
  const {followUpVersion,followUpAt,...current}=order.results[0];
  const notes=history.results.slice(0,limit).map(formatNote);
  const editable=(attemptId===undefined||attemptId===current.attemptId)&&paymentAttentionStates.includes(current.state);
  return {id,target:editable?{...current,...(followUpVersion===null?{}:{followUpVersion,followUpAt})}:null,notes,
    nextBefore:history.results.length>limit?notes.at(-1).id:null};
}

export async function recordPaymentAttentionNote(db,{id,attemptId,state,note,operationId,followUpAt,followUpVersion},now){
  // NULL leaves the previous deadline in force. Zero records an explicit cancellation.
  const storedFollowUp=followUpAt===undefined?null:followUpAt??0;
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO payment_attention_notes(attempt_id,operation_id,state,note,recorded_at,follow_up_at)
      SELECT attempt.id,?,?,?,?,?
      FROM payment_attempts AS attempt JOIN orders ON orders.id=attempt.order_id
      WHERE orders.id=? AND orders.payment_method<>'cash' AND attempt.id=? AND attempt.state=?
        AND attempt.id=(${newest})
        AND (? IS NULL OR (${latestFollowUpId}) IS ?)
      ON CONFLICT DO NOTHING`).bind(operationId,state,note,now,storedFollowUp,id,attemptId,state,storedFollowUp,followUpVersion??null),
    db.prepare(`SELECT ${columns},attempt.order_id AS orderId,attempt.id AS attemptId
      FROM payment_attention_notes AS note JOIN payment_attempts AS attempt ON attempt.id=note.attempt_id
      WHERE note.operation_id=?`).bind(operationId),
  ]);
  const row=saved.results[0];
  if(!row)return null;
  const {orderId,attemptId:savedAttempt,...entry}=row;
  return orderId===id&&savedAttempt===attemptId&&entry.state===state&&entry.note===note&&entry.followUpAt===storedFollowUp?
    formatNote(entry):null;
}
