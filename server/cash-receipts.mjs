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

export async function dailyCashReceipts(db,date,range,capturedAt){
  const {results}=await db.prepare(`SELECT cash_receipts.order_id AS orderId, orders.mode,
    cash_receipts.amount,cash_receipts.tendered,cash_receipts.tendered-cash_receipts.amount AS change,
    cash_receipts.collected_at AS recordedAt
    FROM cash_receipts JOIN orders ON orders.id=cash_receipts.order_id
    WHERE collected_at>=? AND collected_at<? AND collected_at<=?
    ORDER BY collected_at,order_id`).bind(...range,capturedAt).all();
  let net=0n,tendered=0n,change=0n;
  for(const row of results){
    net+=BigInt(row.amount);
    tendered+=BigInt(row.tendered);
    change+=BigInt(row.change);
  }
  return {format:"hey-table.daily-cash.v1",date,timeZone:"Asia/Taipei",capturedAt,
    totals:{receipts:results.length,net:String(net),tendered:String(tendered),change:String(change)},receipts:results};
}
