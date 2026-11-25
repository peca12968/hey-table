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
const focusHeading=node=>node?.focus();

function ReturnPreview({ticket,ledger,staffKey,onChanged,onReload}){
  const [quantities,setQuantities]=useState(()=>new Map()),[result,setResult]=useState(null),[error,setError]=useState("");
  const [attempt,setAttempt]=useState(null),[busy,setBusy]=useState(false),[stale,setStale]=useState(false);
  const [notice,setNotice]=useState(""),inFlight=useRef(false);
  const [voidTarget,setVoidTarget]=useState(null),[reason,setReason]=useState("");
  const pricing=useMemo(()=>{
    try{return remainingReturnLots(returnLots(ticket),ledger.records);}catch{return null;}
  },[ticket,ledger.records]);
  const names=new Map(ticket.items.map(({id,name})=>[id,name]));
  const remaining=id=>pricing?.lots.get(id)?.reduce((sum,lot)=>sum+lot.qty,0)??0;
  const blocked=busy||stale||!!attempt;

  function preview(event){
    event.preventDefault();
    if(blocked||voidTarget)return;
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

  async function mutate(method,data){
    if(inFlight.current||stale)return;
    inFlight.current=true;setBusy(true);setError("");setNotice("");
    setAttempt(data);
    try{
      const saved=await request(endpoint,{method,headers:{"Content-Type":"application/json",...staffHeaders(staffKey)},
        body:JSON.stringify(data),signal:AbortSignal.timeout(15_000)});
      onChanged(ticket.id,method,saved);
      setAttempt(null);setResult(null);setQuantities(new Map());setVoidTarget(null);setReason("");
      setNotice(method==="POST"?"已記入第 "+saved.revision+" 筆試算。":
        "已撤銷第 "+saved.targetRevision+" 筆試算，恢復 NT$ "+saved.restoredAmount+" 可試算金額。");
    }catch(failure){
      if([400,404,409].includes(failure.status)){
        setAttempt(null);setResult(null);setStale(failure.status===409);setError(failure.message);
        if(failure.status===409)setVoidTarget(null);
      }else setError(failure.status===403?failure.message:method==="POST"?
        "尚未收到登記結果，請重試同一筆試算。":"尚未收到撤銷結果，請重試撤銷同一筆。");
    }finally{inFlight.current=false;setBusy(false);}
  }

  function record(){
    if(!result||voidTarget||result.revision!==ledger.revision)return;
    void mutate("POST",attempt??{id:ticket.id,revision:result.revision,operationId:crypto.randomUUID(),amount:result.amount,
      items:[...result.selection].map(([id,qty])=>({id,qty}))});
  }

  function voidQuote(event){
    event.preventDefault();
    if(!voidTarget||!reason.trim())return;
    void mutate("PATCH",attempt??{id:ticket.id,revision:ledger.revision,operationId:crypto.randomUUID(),
      targetRevision:voidTarget.revision,reason:reason.trim()});
  }

  function beginVoid(record){
    setVoidTarget(record);setReason("");setResult(null);setError("");setNotice("");
  }

  return <section className="returnQuote" aria-labelledby="return-quote">
    <h3 id="return-quote">部分退餐試算</h3>
    <p>依原單實付金額及已登記份數試算。同品項先計入實付較高的剩餘份數。</p>
    {pricing?<form onSubmit={preview}>
      {ticket.items.map(({id,name,qty})=><label key={id}>{name}退餐份數
        <small className="muted">原單 {qty} 份 · 可試算 {remaining(id)} 份</small>
        <input type="text" inputMode="numeric" pattern="[0-9]+" maxLength={16} placeholder="0" value={quantities.get(id)??""}
          disabled={blocked||!!voidTarget||remaining(id)===0}
          onChange={event=>{
            const value=event.target.value;
            setQuantities(current=>new Map(current).set(id,value));setResult(null);setError("");
          }}/>
      </label>)}
      <button type="submit" className="outline" disabled={blocked||!!voidTarget||!ticket.items.some(item=>remaining(item.id)>0)}>試算退餐金額</button>
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
      {pricing&&<p>目前試算餘額 <strong>NT$ {pricing.total}</strong></p>}
      <ol>{ledger.records.map(record=><li key={record.revision}>
        <strong>第 {record.revision} 筆 · NT$ {record.amount}</strong>
        <small> <time dateTime={new Date(record.recordedAt).toISOString()}>{taipei.format(record.recordedAt)}</time></small>
        <p>{record.lines.map(({dish,qty,unit})=>names.get(dish)+" "+qty+" 份 × NT$ "+unit).join("、")}</p>
        <p>登記後餘額 NT$ {record.remainingValue}</p>
        {record.voided?<>
          <p><strong>已撤銷</strong> · {record.voided.reason}</p>
          <p>撤銷時間 <time dateTime={new Date(record.voided.recordedAt).toISOString()}>{taipei.format(record.voided.recordedAt)}</time></p>
        </>:<button className="outline" disabled={blocked||!!voidTarget} onClick={()=>beginVoid(record)}>更正第 {record.revision} 筆</button>}
        {voidTarget?.revision===record.revision&&<section className="supplyReview" aria-labelledby="void-return-title">
          <h4 id="void-return-title" tabIndex={-1} ref={focusHeading}>撤銷第 {record.revision} 筆試算</h4>
          <p>這次更正會恢復 NT$ {record.amount} 及該筆的餐點份數。</p>
          <form onSubmit={voidQuote}>
            <label>撤銷原因<textarea required value={reason} maxLength={160} disabled={busy||!!attempt}
              onChange={event=>{setReason(event.target.value);setError("");}}/></label>
            <button type="submit" className="outline" disabled={busy||!reason.trim()}>
              {busy?"撤銷中…":attempt?"重試撤銷同一筆":"確認撤銷試算"}</button>
            <button type="button" className="outline" disabled={busy||!!attempt} onClick={()=>{setVoidTarget(null);setError("");}}>返回紀錄</button>
          </form>
        </section>}
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
  function applyChange(id,method,entry){
    setView(current=>{
      if(current?.ticket.id!==id||entry.revision!==current.ledger.revision+1)return current;
      const records=method==="POST"?[...current.ledger.records,entry]:current.ledger.records.map(record=>
        record.revision===entry.targetRevision?{...record,voided:entry}:record);
      return {ticket:current.ticket,ledger:{revision:entry.revision,records}};
    });
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
      <ReturnPreview ticket={ticket} ledger={ledger} staffKey={staffKey} onChanged={applyChange} onReload={()=>lookup()}/>
    </section>}
  </details>;
}
