"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {businessDate} from "../../../lib/business-day.mjs";
import {pickupWindow} from "../../../lib/pickup-slots.mjs";
import "./slots.css";

const endpoint="/api/kitchen/pickup-slots";
function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}

function SlotLimit({slot,defaultCapacity,busy,onSave}){
  const windowText=pickupWindow(slot.start);
  const [value,setValue]=useState(slot.capacity??"");
  const capacity=value===""?null:Number(value);
  return <article className="sheet slotLimit" aria-label={windowText}>
    <h2>{windowText}</h2>
    <p>已占用 {slot.used} 份 · 剩餘 {slot.remaining} 份</p>
    {slot.editable?<form className="actions" onSubmit={event=>{
      event.preventDefault();
      if(!busy)onSave(slot,capacity);
    }}>
      <label>份數上限<input type="number" min="0" step="1" inputMode="numeric" value={value} disabled={busy}
        placeholder={"預設 "+defaultCapacity} onChange={event=>setValue(event.target.value)}/></label>
      <button className="outline" disabled={busy||capacity===slot.capacity}>儲存上限</button>
    </form>:<p className="muted">已停止預約 · 上限 {slot.capacity??defaultCapacity} 份</p>}
  </article>;
}

export default function PickupSlotLimits(){
  const [date,setDate]=useState(null),[snapshot,setSnapshot]=useState(null),[revision,setRevision]=useState(0);
  const [includeEnded,setIncludeEnded]=useState(false),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(""),[loadError,setLoadError]=useState(""),[saveError,setSaveError]=useState("");
  useEffect(()=>{
    if(date==="")return;
    const controller=new AbortController(),target=date??businessDate(Date.now());
    request(endpoint+"?date="+encodeURIComponent(target),{headers:staffHeaders(),signal:controller.signal}).then(value=>{
      if(!controller.signal.aborted){setSnapshot(value);setLoadError("");setBusy(false);}
    }).catch(error=>{
      if(!controller.signal.aborted){setSnapshot(null);setLoadError(error.message);setBusy(false);}
    });
    return ()=>controller.abort();
  },[date,revision]);
  const current=snapshot&&(date===null||snapshot.date===date)?snapshot:null;
  const rows=current?.slots.filter(slot=>includeEnded||slot.editable)??[];

  function refresh(){
    setNotice("");setSaveError("");setLoadError("");setRevision(value=>value+1);
  }
  async function save(slot,capacity){
    if(busy||!current)return;
    setBusy(true);setNotice("");setSaveError("");
    try{
      await request(endpoint,{method:"PATCH",headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify({date:current.date,start:slot.start,capacity,revision:slot.revision})});
      setNotice(pickupWindow(slot.start)+" 的份數上限已儲存。");
    }catch(error){setSaveError(error.message);}
    finally{setRevision(value=>value+1);}
  }
  return <><Header/><main className="shell section pickupLimits">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>管理預約時段</h1>
    <p>輸入 0 暫停該時段，留空使用預設份數。已成立的預約會保留。</p>
    <div className="actions pickupLimitControls">
      <label>取餐日期<input type="date" value={date??snapshot?.date??""} disabled={busy||(!snapshot&&!loadError&&date===null)} onChange={event=>{
        setDate(event.target.value);setNotice("");setSaveError("");setLoadError("");
      }}/></label>
      <button className="outline" disabled={busy||date===""} onClick={refresh}>重新載入</button>
    </div>
    <label className="pickupIncludeEnded"><input type="checkbox" checked={includeEnded} onChange={event=>setIncludeEnded(event.target.checked)}/>顯示已截止時段</label>
    {notice&&<p role="status">{notice}</p>}
    {(loadError||saveError)&&<p className="error" role="alert">{loadError||saveError}</p>}
    {!current&&!loadError&&date!==""&&<p role="status">正在讀取時段…</p>}
    {current&&rows.length===0&&<p role="status">這天目前沒有可調整的時段。</p>}
    {current&&rows.length>0&&<div className="pickupLimitGrid">
      {rows.map(slot=><SlotLimit key={slot.start+":"+slot.revision} slot={slot} defaultCapacity={current.defaultCapacity} busy={busy} onSave={save}/>)}
    </div>}
  </main><Footer/></>;
}
