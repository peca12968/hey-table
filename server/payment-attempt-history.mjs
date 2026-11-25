const pageSize=10;

export async function readPaymentAttemptHistory(db,id,before){
  const bounded=before!==undefined;
  const earlier=bounded?" AND id<?":"";
  const binds=bounded?[before]:[];
  const [orders,page]=await db.batch([
    db.prepare(`SELECT id,payment_method AS method,payment_env AS environment,
      (SELECT MAX(id) FROM payment_attempts WHERE order_id=orders.id) AS latestId,
      (SELECT COUNT(*) FROM payment_attempts WHERE order_id=orders.id${earlier}) AS available
      FROM orders WHERE id=? AND payment_method<>'cash'`).bind(...binds,id),
    db.prepare(`SELECT attempt.id AS attemptId,attempt.state,attempt.created AS startedAt,
      NULLIF(attempt.checked,0) AS lastCheckedAt,attempt.kitchen_payable_at AS firstPayableAt,
      (SELECT COUNT(*) FROM payment_attention_notes AS note WHERE note.attempt_id=attempt.id) AS noteCount
      FROM payment_attempts AS attempt WHERE attempt.order_id=?${bounded?" AND attempt.id<?":""}
      ORDER BY attempt.id DESC LIMIT ?`).bind(id,...binds,pageSize+1),
  ]);
  const order=orders.results[0];
  if(!order)return null;
  const attempts=page.results.slice(0,pageSize).map((attempt,index)=>({...attempt,
    number:order.available-index,latest:order.latestId===attempt.attemptId,
  }));
  return {id,method:order.method,environment:order.environment,attempts,
    nextBefore:page.results.length>pageSize?attempts.at(-1).attemptId:null};
}
