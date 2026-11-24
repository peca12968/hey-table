export const paymentHoldMs=15*60*1000;

export const noBlockingPayment=`NOT EXISTS (
  SELECT 1 FROM payment_attempts WHERE order_id=orders.id AND state NOT IN ('failed','cancelled')
)`;

export function expirePaymentHolds(db,now,token){
  const scoped=token!==undefined;
  return db.prepare(`UPDATE orders SET status='cancelled',
    status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',
      json_object('from',status,'status','cancelled','at',?,'actor','payment_expiry'))
    WHERE status='pending' AND payment_method<>'cash' AND payment_due_at<=?
      AND ${noBlockingPayment}${scoped?" AND token=?":""}`)
    .bind(now,now,...(scoped?[token]:[]));
}
