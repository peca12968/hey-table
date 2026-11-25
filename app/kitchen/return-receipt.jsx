"use client";
import {useMemo,useRef,useState} from "react";
import {request} from "../shared";
import {numberOf} from "../../lib/menu.mjs";
import {downloadJson} from "../../lib/download-json.mjs";
import {quoteReturn,remainingReturnLots,returnLots} from "../../modules/receipt-returns/quote.mjs";
import "./return-receipt.css";

const endpoint="/api/kitchen/return-receipt";
const taipei=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"short"});
const staffHeaders=key=>key?{Authorization:"Bearer "+key}:{};

function ReturnPreview({ticket,ledger,staffKey,onSaved,onReload}){
  const [quantities,setQuantities]=useState(()=>new Map()),[result,setResult]=useState(null),[error,setError]=useState("");
  const [attempt,setAttempt]=useState(null),[busy,setBusy]=useState(false),[stale,setStale]=useState(false);
  const [notice,setNotice]=useState(""),inFlight=useRef(false);
  const pricing=useMemo(()=>{
    try{return remainingReturnLots(returnLots(ticket),ledger.records);}catch{return null;}
  },[ticket,ledger.records]);
  const names=new Map(ticket.items.map(({id,name})=>[id,name]));
  const remaining=id=>pricing?.lots.get(id)?.reduce((sum,lot)=>sum+lot.qty,0)??0;

  function preview(event){
    event.preventDefault();
    if(busy||stale||attempt)return;
    setNotice("");
    const selection=new Map();
    for(const {id,name} of ticket.items){
      const entered=Number(quantities.get(id)??0);
      if(!Number.isSafeInteger(entered)||entered<0||entered>remaining(id)){
        setResult(null);setError(name+"最多可試算 "+remaining(id)+" 份。");return;
      }
      if(entered)selection.set(id,entered);
    }
    try{setResult({...quoteReturn(pricing,selection),selection,revision:ledger.revision});setError("");}
    catch(error){setError(error.message);}
  }

  async function record(){
    if(inFlight.current||!result||stale||result.revision!==ledger.revision)return;
    inFlight.current=true;setBusy(true);setError("");setNotice("");
    const data=attempt??{id:ticket.id,revision:result.revision,operationId:crypto.randomUUID(),amount:result.amount,
      items:[...result.selection].map(([id,qty])=>({id,qty}))};
    setAttempt(data);
    try{
      const saved=await request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",...staffHeaders(staffKey)},
        body:JSON.stringify(data),signal:AbortSignal.timeout(15_000)});
      onSaved(ticket.id,saved);setAttempt(null);setResult(null);setQuantities(new Map());
      setNotice("已記入第 "+saved.revision+" 筆試算。");
    }catch(failure){
      if([400,404,409].includes(failure.status)){
        setAttempt(null);setResult(null);setStale(failure.status===409);setError(failure.message);
      }else setError(failure.status===403?failure.message:"尚未收到登記結果，請重試同一筆試算。");
    }finally{inFlight.current=false;setBusy(false);}
  }

  return <section className="returnQuote" aria-labelledby="return-quote">
    <h3 id="return-quote">部分退餐試算</h3>
    <p>依原單實付金額及已登記份數試算。同品項先計入實付較高的剩餘份數。</p>
    {pricing?<form onSubmit={preview}>
      {ticket.items.map(({id,name,qty})=><label key={id}>{name}退餐份數
        <small className="muted">原單 {qty} 份 · 可試算 {remaining(id)} 份</small>
        <input type="text" inputMode="numeric" pattern="[0-9]+" maxLength={16} placeholder="0" value={quantities.get(id)??""}
          disabled={busy||stale||!!attempt||remaining(id)===0}
          onChange={event=>{
            const value=event.target.value;
            setQuantities(current=>new Map(current).set(id,value));setResult(null);setError("");
          }}/>
      </label>)}
      <button type="submit" className="outline" disabled={busy||stale||!!attempt||!ticket.items.some(item=>remaining(item.id)>0)}>試算退餐金額</button>
    </form>:<p role="alert">收據計價資料不完整，請核對原單。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {stale&&<button className="outline" onClick={onReload}>重新讀取試算簿</button>}
    {result?.revision===ledger.revision&&<section className="supplyReview" aria-labelledby="return-quote-result">
      <h4 id="return-quote-result">本次退餐試算</h4>
      <ul className="orderLines">{result.lines.map(({dish,bundle,qty,unit,amount})=><li key={JSON.stringify([dish,bundle])}>
        <div><strong>{names.get(dish)}</strong><small>{bundle===null?"單點":"套餐分攤"} · {qty} 份 × NT$ {unit}</small></div>
        <b>NT$ {amount}</b>
      </li>)}</ul>
      <dl>
        <div><dt>試算退餐金額</dt><dd>NT$ {result.amount}</dd></div>
        <div><dt>試算後原單餘額</dt><dd>NT$ {result.remainingValue}</dd></div>
      </dl>
      <button type="button" className="outline" disabled={busy} onClick={record}>
        {busy?"登記中…":attempt?"重試登記同一筆":"記入試算紀錄"}
      </button>
    </section>}
    {ledger.records.length>0&&<details className="returnQuoteHistory" open>
      <summary>試算登記紀錄（{ledger.records.length} 筆）</summary>
      <ol>{ledger.records.map(record=><li key={record.revision}>
        <strong>第 {record.revision} 筆 · NT$ {record.amount}</strong>
        <small> <time dateTime={new Date(record.recordedAt).toISOString()}>{taipei.format(record.recordedAt)}</time></small>
        <p>{record.lines.map(({dish,qty,unit})=>names.get(dish)+" "+qty+" 份 × NT$ "+unit).join("、")}</p>
        <p>登記後餘額 NT$ {record.remainingValue}</p>
      </li>)}</ol>
    </details>}
  </section>;
}

export default function ReturnReceipt({staffKey}) {
  const [number,setNumber] = useState("");
  const [view,setView] = useState(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  async function lookup(event) {
    event?.preventDefault();
    if (busy) return;
    setView(null);
    setError("");
    setBusy(true);
    try {
      const result = await request(endpoint+"?"+new URLSearchParams({id:number.trim(),ledger:"1"}), {
        headers:staffHeaders(staffKey),signal:AbortSignal.timeout(10_000),
      });
      setView(result);
    } catch (e) {
      setError(e.name==="TimeoutError"?"查詢餐單逾時，請再試一次。":e.message);
    } finally {
      setBusy(false);
    }
  }
  function applyEntry(id,entry){
    setView(current=>current?.ticket.id===id&&entry.revision===current.ledger.revision+1
      ?{ticket:current.ticket,ledger:{revision:entry.revision,records:[...current.ledger.records,entry]}}:current);
  }
  const {ticket,ledger}=view??{};
  const quote=ticket?.combo?.quote;
  const prices = new Map(Array.isArray(quote?.lines)?quote.lines.filter(Boolean).map(line=>[line.id,line.total]):[]);
  return <details className="sheet returnReceipt">
    <summary>匯出退餐試算收據</summary>
    <p>依餐號查詢原單計價與退餐試算登記。可下載原收據供離線核對。</p>
    <form onSubmit={lookup}>
      <label>取餐號碼<input type="text" inputMode="numeric" pattern="[0-9]+" required
        value={number} disabled={busy} onChange={event=>{
          setNumber(event.target.value);setView(null);setError("");
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
      <ReturnPreview ticket={ticket} ledger={ledger} staffKey={staffKey} onSaved={applyEntry} onReload={()=>lookup()}/>
    </section>}
  </details>;
}
