export default function CashReceipt({record}){
  return <section className="cashReceipt" aria-label="現金收款紀錄">
    <strong>已登記現金收款</strong>
    <dl>
      <div><dt>應收</dt><dd>NT$ {record.amount}</dd></div>
      <div><dt>實收</dt><dd>NT$ {record.tendered}</dd></div>
      <div><dt>找零</dt><dd>NT$ {record.change}</dd></div>
    </dl>
  </section>;
}
