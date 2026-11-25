"use client";
import {useEffect,useRef,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import {dishes} from "../../../lib/menu.mjs";
import CopyLimits from "./copy-limits";
import "./limits.css";

const endpoint="/api/kitchen/daily-limits";
const taipei=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}
const readLimits=(date,signal)=>request(endpoint+"?date="+encodeURIComponent(date),{headers:staffHeaders(),signal});

function restockDraft(key){
  try{return JSON.parse(sessionStorage.getItem(key));}
  catch{return null;}
}
function rememberRestock(key,operation){
  try{
    if(operation)sessionStorage.setItem(key,JSON.stringify(operation));
    else sessionStorage.removeItem(key);
  }catch{/* The current page can still retry the same request. */}
}

function LimitActions({date,dish,data,disabled,onWrite}){
  const [value,setValue]=useState(data.capacity??"");
  const draftKey="he-ri-portion-restock:"+date+":"+dish.id;
  const [pending,setPending]=useState(()=>restockDraft(draftKey));
  const [quantity,setQuantity]=useState("");
  const added=Number(pending?.quantity??quantity);
  const canRestock=Number.isSafeInteger(added)&&added>0;

  async function restock(event){
    event.preventDefault();
    if(disabled||!canRestock)return;
    const operation=pending??{date,dish:dish.id,revision:data.revision,quantity:added,operationId:crypto.randomUUID()};
    rememberRestock(draftKey,operation);
    setPending(operation);
    try{
      const saved=await onWrite(dish,operation,true);
      if(!saved)return;
      rememberRestock(draftKey,null);
      setPending(null);
      setQuantity("");
    }catch(failure){
      if([400,403,409].includes(failure.status)){
        rememberRestock(draftKey,null);
        setPending(null);
        setQuantity(String(operation.quantity));
      }
    }
  }
  return <>
    <form className="actions" onSubmit={async event=>{
      event.preventDefault();
      try{await onWrite(dish,{date,dish:dish.id,capacity:value===""?null:Number(value),revision:data.revision},false);}
      catch{/* The error is shown above the supply cards. */}
    }}>
      <label>供應上限<input type="number" min="0" step="1" inputMode="numeric" value={value}
        onChange={event=>setValue(event.target.value)} disabled={disabled||!!pending}/></label>
      <button className="outline" disabled={disabled||!!pending||String(value)===String(data.capacity??"")}>儲存上限</button>
    </form>
    {(data.capacity!==null||pending)&&<details className="limitRestock" open={pending?true:undefined}>
      <summary>補貨增加可售份數</summary>
      <form className="actions" onSubmit={restock}>
        <label>補貨份數<input type="number" min="1" step="1" inputMode="numeric" value={pending?.quantity??quantity}
          onChange={event=>setQuantity(event.target.value)} disabled={disabled||!!pending} required/></label>
        <button className="outline" disabled={disabled||!canRestock}>{pending?"重試補貨":"確認補貨"}</button>
      </form>
      {pending&&<p role="status">可重試同一筆補貨，避免重複增加份數。</p>}
    </details>}
  </>;
}

const capacityLabel=capacity=>capacity===null?"不限量":String(capacity);

function LimitRecords({date,dish,restocksOnly}){
  const [cursors,setCursors]=useState([null]),[reload,setReload]=useState(0),[view,setView]=useState(null);
  const before=cursors.at(-1);
  useEffect(()=>{
    const controller=new AbortController();
    const query=new URLSearchParams({date,dish:dish.id});
    if(before!==null)query.set("before",String(before));
    request(endpoint+(restocksOnly?"/restock?":"/history?")+query,{
      headers:staffHeaders(),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(page=>{if(!controller.signal.aborted)setView({before,reload,page});})
      .catch(failure=>{if(!controller.signal.aborted)setView({before,reload,error:
        failure.name==="TimeoutError"?"讀取供應紀錄逾時，請重試。":failure.message});});
    return ()=>controller.abort();
  },[date,dish.id,before,reload,restocksOnly]);
  const current=view?.before===before&&view.reload===reload?view:null;
  const page=current?.page;
  return <>
    {!current&&<p role="status">正在讀取供應紀錄…</p>}
    {current?.error&&<p role="alert" className="error">{current.error}</p>}
    {page?.records.length===0&&<p>這一天沒有{restocksOnly?"補貨":"供應變更"}紀錄。</p>}
    {page?.records.length>0&&<ol aria-label="供應紀錄明細" className="restockRecords">
      {page.records.map(record=>{
        const kind=record.kind??"restock",at=record.changedAt??record.restockedAt;
        const title=kind==="manual"?"手動儲存":kind==="copy"?"跨日複製":"補貨 "+record.quantity+" 份";
        return <li key={record.revision}>
          <div><strong>{title}</strong><span>第 {record.revision} 版</span></div>
          <time dateTime={new Date(at).toISOString()}>{taipei.format(at)}</time>
          <p>供應上限 {capacityLabel(record.previousCapacity)} → {capacityLabel(record.capacity)}
            {kind==="restock"?" · 當時已占用 "+record.used+" 份":kind==="copy"?" · 來源 "+record.sourceDate:null}</p>
        </li>;
      })}
    </ol>}
    {current&&<div className="actions">
      <button className="outline" onClick={()=>{setCursors([null]);setReload(value=>value+1);}}>重新查詢紀錄</button>
      {cursors.length>1&&<button className="outline" onClick={()=>setCursors(previous=>previous.slice(0,-1))}>較新一頁</button>}
      {page?.nextBefore!=null&&<button className="outline" onClick={()=>setCursors(previous=>
        previous.at(-1)===before?[...previous,page.nextBefore]:previous)}>更早紀錄</button>}
      {page?.records.length>0&&<button className="outline" onClick={()=>downloadJson(
        (restocksOnly?"hey-table-restock-":"hey-table-limit-history-")+date+"-"+dish.id+"-",page.capturedAt,page)}>下載這頁 JSON</button>}
    </div>}
  </>;
}

function LimitHistory({date,dish,revision}){
  const [scope,setScope]=useState("all");
  return <section aria-label={dish.name+"供應變更紀錄"}>
    <label>紀錄範圍<select value={scope} onChange={event=>setScope(event.target.value)}>
      <option value="all">所有變更</option><option value="restock">只看補貨</option>
    </select></label>
    {scope==="all"&&<p className="muted">手動儲存與跨日複製從紀錄啟用後開始保存。</p>}
    <LimitRecords key={revision+":"+scope} date={date} dish={dish} restocksOnly={scope==="restock"}/>
  </section>;
}

function LimitCard({date,dish,data,disabled,onWrite}){
  const [historyOpen,setHistoryOpen]=useState(false);
  const remaining=data.capacity===null?"不限量":Math.max(0,data.capacity-data.used)+" 份";
  return <article className="sheet limitCard" aria-label={dish.name}>
    <h2>{dish.name}</h2>
    <p>已占用 {data.used} 份 · 剩餘 {remaining}</p>
    <LimitActions key={data.revision} date={date} dish={dish} data={data} disabled={disabled} onWrite={onWrite}/>
    <details className="limitRestock" onToggle={event=>setHistoryOpen(event.currentTarget.open)}>
      <summary>查看供應變更紀錄</summary>
      {historyOpen&&<LimitHistory date={date} dish={dish} revision={data.revision}/>}
    </details>
  </article>;
}

export default function DailyLimits(){
  const [selectedDate,setSelectedDate]=useState(null),[reload,setReload]=useState(0),[snapshot,setSnapshot]=useState(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const today=useBusinessToday();
  const date=selectedDate??today;
  const inFlight=useRef(false);
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController();
    readLimits(date,AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]))
      .then(value=>{if(!controller.signal.aborted)setSnapshot(value);})
      .catch(failure=>{if(!controller.signal.aborted){setSnapshot(null);setError(failure.message);}});
    return ()=>controller.abort();
  },[date,reload]);
  const current=snapshot?.date===date?snapshot:null;
  function select(value){
    setSelectedDate(value);setSnapshot(null);setMessage("");setError("");
  }
  function refresh(){
    setError("");setMessage("");setReload(value=>value+1);
  }
  async function write({path=endpoint,method,operation,describe,uncertain,refreshOnError=false}){
    if(inFlight.current)return null;
    inFlight.current=true;
    setBusy(true);setMessage("");setError("");
    try{
      const saved=await request(path,{method,
        headers:{"Content-Type":"application/json",...staffHeaders()},
        signal:AbortSignal.timeout(15_000),body:JSON.stringify(operation)});
      setSnapshot(old=>{
        if(old?.date!==operation.date)return old;
        const limits={...old.limits};
        for(const {dish,capacity,revision} of saved.limits??[saved]){
          if(limits[dish].revision<revision)limits[dish]={...limits[dish],capacity,revision};
        }
        return {...old,limits};
      });
      setMessage(describe(saved));
      setReload(value=>value+1);
      return saved;
    }catch(failure){
      setError(uncertain&&![400,403,409].includes(failure.status)?uncertain:failure.message);
      if(refreshOnError)setReload(value=>value+1);
      throw failure;
    }finally{
      inFlight.current=false;
      setBusy(false);
    }
  }
  const writeLimit=(dish,operation,restocking)=>restocking?write({path:endpoint+"/restock",method:"POST",operation,
    describe:saved=>"已為 "+operation.date+" 的 "+dish.name+" 補貨 "+saved.quantity+" 份。",
    uncertain:"尚未收到補貨結果，請重試同一筆補貨。"}):
    write({method:"PATCH",operation,describe:()=>"已儲存 "+dish.name+" 的供應上限。"});
  const copy=operation=>write({path:endpoint+"/copy",method:"POST",operation,
    describe:saved=>"已複製 "+saved.limits.length+" 個品項上限。",
    uncertain:"尚未收到套用結果，請重新讀取兩個日期確認。",refreshOnError:true});
  return <><Header/><main className="shell section dailyLimits">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>每日限量供應</h1>
    <p>按台灣日期設定可售份數。空白為不限量，0 為當日停止供應。</p>
    <div className="actions limitDate">
      <label>供應日期<input type="date" value={date} disabled={busy} onChange={event=>select(event.target.value)}/></label>
      <button className="outline" disabled={!date||busy} onClick={refresh}>重新載入</button>
    </div>
    {error&&<p className="error" role="alert">{error}</p>}
    {message&&<p role="status">{message}</p>}
    {date&&!current&&!error&&<p role="status">正在讀取供應份數…</p>}
    {current&&<CopyLimits key={date} date={date} limits={current.limits} disabled={busy} loadSource={readLimits} onCopy={copy}/>}
    {current&&<div className="kGrid">{dishes.map(dish=><LimitCard
      key={date+":"+dish.id} date={date} dish={dish} data={current.limits[dish.id]}
      disabled={busy} onWrite={writeLimit}/>)}</div>}
  </main><Footer/></>;
}
