export const cashReceiptColumn=`(SELECT json_object('amount',amount,'tendered',tendered,'change',tendered-amount,'collectedAt',collected_at)
  FROM cash_receipts WHERE order_id=orders.id)`;

export async function collectCash(db,{id,operationId,expectedTotal,tendered},now){
  const [,lookup]=await db.batch([
    db.prepare(`INSERT INTO cash_receipts(order_id,operation_id,amount,tendered,collected_at)
      SELECT id,?,total,?,? FROM orders
      WHERE id=? AND payment_method='cash' AND status IN ('ready','completed') AND total=? AND total<=?
      ON CONFLICT DO NOTHING`).bind(operationId,tendered,now,id,expectedTotal,tendered),
    db.prepare(`SELECT orders.payment_method,orders.status,orders.total,cash_receipts.operation_id,
      ${cashReceiptColumn} AS cash_receipt
      FROM orders LEFT JOIN cash_receipts ON order_id=orders.id WHERE orders.id=?`).bind(id),
  ]);
  return lookup.results[0];
}
