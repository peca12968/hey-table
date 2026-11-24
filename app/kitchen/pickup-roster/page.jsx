"use client";

import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {labels,numberOf} from "../../../lib/menu.mjs";
import {methods,paymentStates} from "../../../lib/payments.mjs";
import {pickupWindow} from "../../../lib/pickup-slots.mjs";
import "./roster.css";

const taipei=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});

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
  const [day,setDay]=useState(null),[revision,setRevision]=useState(0),[view,setView]=useState(null);
  const [includeCancelled,setIncludeCancelled]=useState(false);
  const date=day??today;
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/pickup-roster?date="+encodeURIComponent(date),{
      headers:key?{Authorization:"Bearer "+key}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(snapshot=>{
      if(!controller.signal.aborted)setView({date,revision,snapshot});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({date,revision,error:error.name==="TimeoutError"?"讀取預約清單逾時，請重新擷取。":error.message,
        denied:error.status===403});
    });
    return ()=>controller.abort();
  },[date,revision]);
  const current=view?.date===date&&view.revision===revision?view:null;
  const snapshot=current?.snapshot;
  const visibleCount=snapshot?snapshot.totals.bookings+(includeCancelled?snapshot.totals.cancelled:0):0;

  return <><Header/><main className="shell section pickupRoster">
    <a className="textLink rosterControl" href="/kitchen">返回店家接單台</a>
    <h1>自取預約清單</h1>
    <div className="actions rosterControl">
      <label>取餐日期<input type="date" value={date} disabled={!today} onChange={event=>setDay(event.target.value)}/></label>
      <button className="outline" disabled={!date||!current} onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
      <button className="outline" disabled={!snapshot||!visibleCount} onClick={()=>window.print()}>列印預約清單</button>
    </div>
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="primary rosterControl" href="/signin-with-chatgpt?return_to=%2Fkitchen%2Fpickup-roster" target="_top">使用 ChatGPT 登入</a>}
    {date&&!current&&<p role="status">正在讀取預約清單…</p>}
    {snapshot&&<>
      <p><b>{snapshot.date}</b> · {snapshot.totals.bookings} 張有效預約 · {snapshot.totals.portions} 份</p>
      <p>台北擷取時間 <time dateTime={new Date(snapshot.capturedAt).toISOString()}>{taipei.format(snapshot.capturedAt)}</time></p>
      {!snapshot.accepting&&<p>這天已暫停新預約及改入。</p>}
      {snapshot.totals.cancelled>0&&<label className="rosterControl rosterCancelled"><input type="checkbox" checked={includeCancelled}
        onChange={event=>setIncludeCancelled(event.target.checked)}/>顯示 {snapshot.totals.cancelled} 張已取消餐單</label>}
      {visibleCount===0&&<p className="sheet">這天沒有{includeCancelled?"":"有效的"}自取預約。</p>}
      {snapshot.windows.map(slot=><RosterWindow key={slot.start} slot={slot} includeCancelled={includeCancelled}/>)}
    </>}
  </main><Footer/></>;
}
