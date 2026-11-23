"use client";
import {useState} from "react";
import {request} from "../shared";
import {numberOf} from "../../lib/menu.mjs";
import {downloadJson} from "../../lib/download-json.mjs";
import "./return-receipt.css";

export default function ReturnReceipt({staffKey}) {
  const [number,setNumber] = useState("");
  const [ticket,setTicket] = useState(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  async function lookup(event) {
    event.preventDefault();
    if (busy) return;
    setTicket(null);
    setError("");
    setBusy(true);
    try {
      const result = await request("/api/kitchen/return-receipt?id="+encodeURIComponent(number.trim()), {
        headers:staffKey ? {Authorization:"Bearer "+staffKey} : {}
      });
      setTicket(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const prices = new Map(ticket?.combo?.quote.lines.map(line => [line.id,line.total]));
  return <details className="sheet returnReceipt">
    <summary>匯出退餐試算收據</summary>
    <p>可依取餐號碼查詢舊單。下載的 JSON 可匯入 Receipt Returns，按原單價格試算分批退餐。</p>
    <form onSubmit={lookup}>
      <label>取餐號碼<input type="text" inputMode="numeric" pattern="[0-9]+" required
        value={number} disabled={busy} onChange={event=>{
          setNumber(event.target.value);setTicket(null);setError("");
        }}/></label>
      <button className="outline" disabled={busy}>{busy?"查詢中…":"查詢計價明細"}</button>
    </form>
    {error&&<p role="alert" className="error">{error}</p>}
    {ticket&&<section aria-label="收據計價明細">
      <h3>取餐號碼 {numberOf(ticket.id)}</h3>
      <time dateTime={new Date(ticket.created).toISOString()}>{new Date(ticket.created).toLocaleString("zh-TW",{timeZone:"Asia/Taipei"})}</time>
      <ul className="orderLines">{ticket.items.map(item=><li key={item.id}>
        <span>{item.name} × {item.qty}</span><b>NT$ {prices.get(item.id) ?? item.price*item.qty}</b>
      </li>)}</ul>
      {ticket.combo&&<p>餐點原價 NT$ {ticket.combo.quote.subtotal} · 套餐折抵 NT$ {ticket.combo.quote.discount}</p>}
      <div className="total"><span>原單合計</span><b>NT$ {ticket.total}</b></div>
      <button type="button" className="outline" onClick={()=>
        downloadJson("hey-table-return-"+numberOf(ticket.id)+"-",ticket.created,ticket)}>下載試算收據 JSON</button>
    </section>}
  </details>;
}
