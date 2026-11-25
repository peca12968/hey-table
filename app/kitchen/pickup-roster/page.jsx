"use client";

import {useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {labels,numberOf} from "../../../lib/menu.mjs";
import {methods,paymentStates} from "../../../lib/payments.mjs";
import {businessDayRange} from "../../../lib/business-day.mjs";
import {pickupRosterPath,pickupSlotsForDay,pickupWindow} from "../../../lib/pickup-slots.mjs";
import "./roster.css";

const taipei=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
const rosterScopeChanged="pickup-roster-scope";
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;

function subscribeToScope(notify){
  window.addEventListener(rosterScopeChanged,notify);
  window.addEventListener("popstate",notify);
  return ()=>{
    window.removeEventListener(rosterScopeChanged,notify);
    window.removeEventListener("popstate",notify);
  };
}

function RosterWindow({slot,includeCancelled}){
  const visible=includeCancelled?slot.orders:slot.orders.filter(order=>order.status!=="cancelled");
  if(!visible.length)return null;
  const title=pickupWindow(slot.start);
  return <section className="sheet rosterWindow" aria-label={title}>
    <h2>{title}<span>預約 {slot.portions} 份</span></h2>
    <table aria-label={title+" 的自取餐單"}>
      <thead><tr><th scope="col">取餐號碼</th><th scope="col">份數</th><th scope="col">付款</th><th scope="col">餐單狀態</th></tr></thead>
      <tbody>{visible.map(order=><tr key={order.id}>
        <th scope="row"><a className="textLink" href={"/kitchen?pickup="+numberOf(order.id)}>#{numberOf(order.id)}</a>
          <small>{order.source==="staff"?"店員代建":"線上自取"}</small></th>
        <td>{order.portions}</td>
        <td>{methods[order.paymentMethod]??"未記錄"}{order.paymentMethod==="cash"?
          (order.cashCollected&&<small>已登記收款</small>):<small>{paymentStates[order.paymentState]??"未記錄"}</small>}</td>
        <td>{labels[order.status]}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}

export default function PickupRoster(){
  const today=useBusinessToday();
  const [revision,setRevision]=useState(0),[view,setView]=useState(null);
  const [includeCancelled,setIncludeCancelled]=useState(false);
  const search=useSyncExternalStore(subscribeToScope,browserSearch,serverSearch);
  const scope=new URLSearchParams(search??"");
  const date=search===null?"":scope.get("date")??today;
  const slot=scope.get("slot");
  const slots=pickupSlotsForDay(date);
  const start=slots.find(value=>String(value)===slot)??null;
  const invalidDate=Boolean(date)&&!businessDayRange(date);
  const invalidSlot=slot!==null&&start===null;
  const path=date&&!invalidDate&&!invalidSlot?pickupRosterPath(date,start):null;
  useEffect(()=>{
    if(!path)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api"+path,{
      headers:key?{Authorization:"Bearer "+key}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(snapshot=>{
      if(!controller.signal.aborted)setView({path,revision,snapshot});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({path,revision,error:error.name==="TimeoutError"?"讀取預約清單逾時，請重新擷取。":error.message,
        denied:error.status===403});
    });
    return ()=>controller.abort();
  },[path,revision]);
  const current=view?.path===path&&view.revision===revision?view:null;
  const snapshot=current?.snapshot;
  const visibleCount=snapshot?snapshot.totals.bookings+(includeCancelled?snapshot.totals.cancelled:0):0;

  function choose(day,slot){
    window.history.replaceState(window.history.state,"",pickupRosterPath(day,slot));
    window.dispatchEvent(new Event(rosterScopeChanged));
    setRevision(value=>value+1);
  }

  return <><Header/><main className="shell section pickupRoster">
    <a className="textLink rosterControl" href="/kitchen">返回店家接單台</a>
    <h1>自取預約清單</h1>
    <div className="actions rosterControl">
      <label>取餐日期<input type="date" value={date} disabled={!today||search===null} onChange={event=>choose(event.target.value,null)}/></label>
      <label>取餐時段<select value={invalidSlot?"invalid":start??""} disabled={!slots.length} onChange={event=>
        choose(date,event.target.value===""?null:Number(event.target.value))}>
        <option value="">全日時段</option>
        {invalidSlot&&<option value="invalid" disabled>請選擇時段</option>}
        {slots.map(slot=><option key={slot} value={slot}>{pickupWindow(slot)}</option>)}
      </select></label>
      <button className="outline" disabled={!current} onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
      <button className="outline" disabled={!snapshot||!visibleCount} onClick={()=>window.print()}>列印預約清單</button>
    </div>
    {(invalidDate||invalidSlot||current?.error)&&<p className="error" role="alert">{invalidDate?"請選擇有效的取餐日期。":
      invalidSlot?"請選擇這個日期的取餐時段。":current.error}</p>}
    {current?.denied&&<a className="primary rosterControl" href={"/signin-with-chatgpt?return_to="+encodeURIComponent(path)} target="_top">使用 ChatGPT 登入</a>}
    {path&&!current&&<p role="status">正在讀取預約清單…</p>}
    {snapshot&&<>
      <p><b>{snapshot.date}{start!==null&&" · "+pickupWindow(start)}</b> · {snapshot.totals.bookings} 張有效預約 · {snapshot.totals.portions} 份</p>
      <p>台北擷取時間 <time dateTime={new Date(snapshot.capturedAt).toISOString()}>{taipei.format(snapshot.capturedAt)}</time></p>
      {!snapshot.accepting&&<p>這天已暫停新預約及改入。</p>}
      {snapshot.totals.cancelled>0&&<label className="rosterControl rosterCancelled"><input type="checkbox" checked={includeCancelled}
        onChange={event=>setIncludeCancelled(event.target.checked)}/>顯示 {snapshot.totals.cancelled} 張已取消餐單</label>}
      {visibleCount===0&&<p className="sheet">{start===null?"這天":"這個時段"}沒有{includeCancelled?"":"有效的"}自取預約。</p>}
      {snapshot.windows.map(slot=><RosterWindow key={slot.start} slot={slot} includeCancelled={includeCancelled}/>)}
    </>}
  </main><Footer/></>;
}
