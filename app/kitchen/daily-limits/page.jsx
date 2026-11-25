"use client";
import {useEffect,useRef,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {dishes} from "../../../lib/menu.mjs";
import "./limits.css";

const endpoint="/api/kitchen/daily-limits";
function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}

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

function LimitCard({date,dish,data,disabled,onWrite}){
  const [value,setValue]=useState(data.capacity??"");
  const draftKey="he-ri-portion-restock:"+date+":"+dish.id;
  const [pending,setPending]=useState(()=>restockDraft(draftKey));
  const [quantity,setQuantity]=useState("");
  const added=Number(pending?.quantity??quantity);
  const canRestock=Number.isSafeInteger(added)&&added>0;
  const remaining=data.capacity===null?"不限量":Math.max(0,data.capacity-data.used)+" 份";

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
  return <article className="sheet limitCard" aria-label={dish.name}>
    <h2>{dish.name}</h2>
    <p>已占用 {data.used} 份 · 剩餘 {remaining}</p>
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
    request(endpoint+"?date="+encodeURIComponent(date),{headers:staffHeaders(),
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])})
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
  async function write(dish,operation,restocking){
    if(inFlight.current)return null;
    inFlight.current=true;
    setBusy(true);setMessage("");setError("");
    try{
      const saved=await request(restocking?endpoint+"/restock":endpoint,{method:restocking?"POST":"PATCH",
        headers:{"Content-Type":"application/json",...staffHeaders()},
        signal:AbortSignal.timeout(15_000),body:JSON.stringify(operation)});
      setSnapshot(old=>old?.date===operation.date&&old.limits[dish.id].revision<saved.revision?
        {...old,limits:{...old.limits,[dish.id]:{...old.limits[dish.id],capacity:saved.capacity,revision:saved.revision}}}:old);
      setMessage(restocking?"已為 "+operation.date+" 的 "+dish.name+" 補貨 "+saved.quantity+" 份。":
        "已儲存 "+dish.name+" 的供應上限。");
      setReload(value=>value+1);
      return saved;
    }catch(failure){
      setError(restocking&&![400,403,409].includes(failure.status)?"尚未收到補貨結果，請重試同一筆補貨。":failure.message);
      throw failure;
    }finally{
      inFlight.current=false;
      setBusy(false);
    }
  }
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
    {current&&<div className="kGrid">{dishes.map(dish=><LimitCard
      key={date+":"+dish.id+":"+current.limits[dish.id].revision} date={date} dish={dish} data={current.limits[dish.id]}
      disabled={busy} onWrite={write}/>)}</div>}
  </main><Footer/></>;
}
