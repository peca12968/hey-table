"use client";
import {useMemo,useState} from "react";
import {request} from "../shared";
import {numberOf} from "../../lib/menu.mjs";
import {downloadJson} from "../../lib/download-json.mjs";
import {quoteReturn,returnLots} from "../../modules/receipt-returns/quote.mjs";
import "./return-receipt.css";

function ReturnPreview({ticket}){
  const [quantities,setQuantities]=useState(()=>new Map()),[result,setResult]=useState(null),[error,setError]=useState("");
  const pricing=useMemo(()=>{
    try{return returnLots(ticket);}catch{return null;}
  },[ticket]);
  const names=new Map(ticket.items.map(({id,name})=>[id,name]));

  function preview(event){
    event.preventDefault();
    const selection=new Map();
    for(const {id,name,qty} of ticket.items){
      const entered=Number(quantities.get(id)??0);
      if(!Number.isSafeInteger(entered)||entered<0||entered>qty){
        setError(name+"最多可試算 "+qty+" 份。");return;
      }
      if(entered)selection.set(id,entered);
    }
    try{setResult(quoteReturn(pricing,selection));setError("");}
    catch(error){setError(error.message);}
  }

  return <section className="returnQuote" aria-labelledby="return-quote">
    <h3 id="return-quote">部分退餐試算</h3>
    <p>依原單金額試算單次退餐。同品項先計入實付較高的份數。</p>
    {pricing?<form onSubmit={preview}>
      {ticket.items.map(({id,name,qty})=><label key={id}>{name}退餐份數
        <small className="muted">原單 {qty} 份</small>
        <input type="text" inputMode="numeric" pattern="[0-9]+" maxLength={16} placeholder="0" value={quantities.get(id)??""}
          onChange={event=>{
            const value=event.target.value;
            setQuantities(current=>new Map(current).set(id,value));setResult(null);setError("");
          }}/>
      </label>)}
      <button type="submit" className="outline">試算退餐金額</button>
    </form>:<p role="alert">收據計價資料不完整，請核對原單。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {result&&<section className="supplyReview" aria-labelledby="return-quote-result">
      <h4 id="return-quote-result">本次退餐試算</h4>
      <ul className="orderLines">{result.lines.map(({dish,bundle,qty,unit,amount})=><li key={JSON.stringify([dish,bundle])}>
        <div><strong>{names.get(dish)}</strong><small>{bundle===null?"單點":"套餐分攤"} · {qty} 份 × NT$ {unit}</small></div>
        <b>NT$ {amount}</b>
      </li>)}</ul>
      <dl>
        <div><dt>試算退餐金額</dt><dd>NT$ {result.amount}</dd></div>
        <div><dt>試算後原單餘額</dt><dd>NT$ {result.remainingValue}</dd></div>
      </dl>
    </section>}
  </section>;
}

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
        headers:staffKey ? {Authorization:"Bearer "+staffKey} : {},signal:AbortSignal.timeout(10_000),
      });
      setTicket(result);
    } catch (e) {
      setError(e.name==="TimeoutError"?"查詢餐單逾時，請再試一次。":e.message);
    } finally {
      setBusy(false);
    }
  }
  const quote=ticket?.combo?.quote;
  const prices = new Map(Array.isArray(quote?.lines)?quote.lines.filter(Boolean).map(line=>[line.id,line.total]):[]);
  return <details className="sheet returnReceipt">
    <summary>匯出退餐試算收據</summary>
    <p>依餐號查詢原單計價與試算退餐。可下載收據，交給 Receipt Returns 登記分次試算。</p>
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
      {quote&&<p>餐點原價 NT$ {quote.subtotal} · 套餐折抵 NT$ {quote.discount}</p>}
      <div className="total"><span>原單合計</span><b>NT$ {ticket.total}</b></div>
      <button type="button" className="outline" onClick={()=>
        downloadJson("hey-table-return-"+numberOf(ticket.id)+"-",ticket.created,ticket)}>下載試算收據 JSON</button>
      <ReturnPreview ticket={ticket}/>
    </section>}
  </details>;
}
