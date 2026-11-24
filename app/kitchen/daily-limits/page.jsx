"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {businessDate} from "../../../lib/business-day.mjs";
import {dishes} from "../../../lib/menu.mjs";
import "./limits.css";

const endpoint="/api/kitchen/daily-limits";
function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}

function LimitCard({dish,data,disabled,onSave}){
  const [value,setValue]=useState(data.capacity??"");
  const remaining=data.capacity===null?"不限量":Math.max(0,data.capacity-data.used)+" 份";
  return <article className="sheet limitCard" aria-label={dish.name}>
    <h2>{dish.name}</h2>
    <p>已占用 {data.used} 份 · 剩餘 {remaining}</p>
    <form className="actions" onSubmit={event=>{
      event.preventDefault();
      onSave(dish,value===""?null:Number(value),data.revision);
    }}>
      <label>供應上限<input type="number" min="0" step="1" inputMode="numeric" value={value}
        onChange={event=>setValue(event.target.value)} disabled={disabled}/></label>
      <button className="outline" disabled={disabled||String(value)===String(data.capacity??"")}>儲存上限</button>
    </form>
  </article>;
}

export default function DailyLimits(){
  const [date,setDate]=useState(""),[reload,setReload]=useState(0),[snapshot,setSnapshot]=useState(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  useEffect(()=>{setDate(businessDate(Date.now()));},[]);
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController();
    request(endpoint+"?date="+encodeURIComponent(date),{headers:staffHeaders(),signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setSnapshot(value);})
      .catch(failure=>{if(!controller.signal.aborted){setSnapshot(null);setError(failure.message);}});
    return ()=>controller.abort();
  },[date,reload]);
  const current=snapshot?.date===date?snapshot:null;
  function select(value){
    setDate(value);setSnapshot(null);setMessage("");setError("");
  }
  function refresh(){
    setError("");setMessage("");setReload(value=>value+1);
  }
  async function save(dish,capacity,revision){
    if(busy)return;
    setBusy(true);setMessage("");setError("");
    try{
      const saved=await request(endpoint,{method:"PATCH",
        headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify({date,dish:dish.id,capacity,revision})});
      setSnapshot(old=>old?.date===date?
        {...old,limits:{...old.limits,[dish.id]:{...old.limits[dish.id],capacity:saved.capacity,revision:saved.revision}}}:old);
      setMessage("已儲存 "+dish.name+" 的供應上限。");
      setReload(value=>value+1);
    }catch(failure){
      setError(failure.message);
    }finally{
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
      key={date+":"+dish.id+":"+current.limits[dish.id].revision} dish={dish} data={current.limits[dish.id]}
      disabled={busy} onSave={save}/>)}</div>}
  </main><Footer/></>;
}
