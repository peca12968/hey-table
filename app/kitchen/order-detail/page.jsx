"use client";

import {useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,Mode,PickupAppointment,request} from "../../shared";
import {ItemNote} from "../../item-notes";
import OrderProgress,{ProgressTime} from "../../order-progress";
import CashReceipt from "../../cash-receipt";
import {labels,numberOf} from "../../../lib/menu.mjs";
import {businessDayRange} from "../../../lib/business-day.mjs";
import {environmentLabel,methods,paymentStates} from "../../../lib/payments.mjs";
import {pickupChangeWindows} from "../../../lib/pickup-slots.mjs";
import {stationLabels} from "../../../lib/kitchen-timing.mjs";
import PaymentAttentionNotes from "../payment-attention-notes";
import PaymentAttemptHistory from "../payment-attempt-history";
import PickupDelayHistory from "../pickup-delay-history";
import "../daily/daily.css";

const pagePath="/kitchen/order-detail";
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;
function subscribeToSearch(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}
const dateTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"short"});
const currency=value=>"NT$ "+value.toLocaleString("zh-TW");

function OperationalHistory({order}){
  const changes=order.tableMoves.map(({from,to,at})=>({text:"從 "+from+" 桌移到 "+to+" 桌",at}));
  for(const change of order.pickupChanges){
    const [oldSlot,newSlot]=pickupChangeWindows(change);
    const actor=change.actor==="staff"?"店員":"顧客";
    changes.push({text:actor+"將取餐時段從 "+oldSlot+" 改到 "+newSlot,at:change.at});
  }
  if(order.pickupArrivedAt!=null)changes.push({text:"自取已回報到店",at:order.pickupArrivedAt});
  changes.sort((a,b)=>(a.at??0)-(b.at??0));
  return <>
    {order.stations.length>0&&<section className="receiptProgress" aria-labelledby="order-stations">
      <h2 id="order-stations">分站進度</h2>
      <ol role="list">{order.stations.map(({station,doneAt})=><li key={station}>
        <span>{stationLabels[station]??"其他餐點"}</span>
        {doneAt==null?<small>{order.status==="cancelled"?"取消前未回報":"尚未回報"}</small>:<ProgressTime at={doneAt}/>}
      </li>)}</ol>
    </section>}
    {changes.length>0&&<section className="receiptProgress" aria-labelledby="order-changes">
      <h2 id="order-changes">桌號與自取異動</h2>
      <ol role="list">{changes.map(({text,at},index)=><li key={index}><span>{text}</span><ProgressTime at={at}/></li>)}</ol>
    </section>}
  </>;
}

function OrderDetails({order,query}){
  const payment=order.paymentMethod==="cash"
    ?order.cashReceipt?"已登記":"尚無現金收款紀錄"
    :paymentStates[order.paymentState]??order.paymentState;
  const paymentEnvironment=environmentLabel(order.paymentEnv);
  const selectedAttempt=query.get("attempt"),paymentBefore=query.get("paymentBefore");
  const allNotes=new URLSearchParams(query);
  allNotes.delete("attempt");
  allNotes.set("notes","1");
  return <article className="sheet orderLookup" aria-labelledby="order-detail-number">
    <div className="menuTitle"><h2 id="order-detail-number">餐單 #{numberOf(order.id)}</h2>
      <strong>{order.status==="completed"?"已交餐":labels[order.status]}</strong></div>
    <Mode table={order.table} source={order.source}/>
    <p>成立於 <time dateTime={new Date(order.created).toISOString()}>{dateTime.format(order.created)}</time></p>
    <PickupAppointment start={order.pickupSlot}/>
    <ul className="orderLines">{order.items.map(({id,name,qty,price,note})=><li key={id}>
      <div>{name} × {qty}<ItemNote note={note}/></div><b>{currency(price*qty)}</b>
    </li>)}</ul>
    {(order.note||order.noteUpdatedAt!=null)&&<p className="orderNoteText">餐單備註　{order.note||"已清除"}</p>}
    {order.noteUpdatedAt!=null&&<p className="muted">顧客更新備註 · <ProgressTime at={order.noteUpdatedAt}/></p>}
    {order.pricing?.discount>0&&<p>餐點原價 {currency(order.pricing.subtotal)} · 套餐折抵 {currency(order.pricing.discount)}</p>}
    <div className="total"><span>原單合計</span><b>{currency(order.total)}</b></div>
    <p>{methods[order.paymentMethod]??"付款方式未記錄"} · {payment}{paymentEnvironment?" · "+paymentEnvironment:""}</p>
    {order.cashReceipt&&<CashReceipt record={order.cashReceipt}/>}
    {order.demoRefund&&<p>示範退款 {currency(order.demoRefund.amount)} · <ProgressTime at={order.demoRefund.refundedAt}/></p>}
    {order.paymentMethod!=="cash"&&<>
      <PaymentAttemptHistory key={"attempts:"+order.id+":"+paymentBefore} id={order.id} query={query.toString()}
        autoOpen={query.get("attempts")==="1"||selectedAttempt!==null}/>
      <PaymentAttentionNotes key={"notes:"+order.id+":"+selectedAttempt} id={order.id} attemptId={selectedAttempt}
        autoOpen={query.get("notes")==="1"||selectedAttempt!==null}
        allNotes={selectedAttempt!==null?pagePath+"?"+allNotes+"#payment-attention-notes":null}/>
    </>}
    <OrderProgress history={order.statusHistory}/>
    <OperationalHistory order={order}/>
    {order.mode==="pickup"&&<PickupDelayHistory key={order.id+":"+query.get("delayBefore")} id={order.id}
      query={query.toString()} autoOpen={query.get("delays")==="1"||query.has("delayBefore")}/>}
  </article>;
}

export default function KitchenOrderDetail(){
  const search=useSyncExternalStore(subscribeToSearch,browserSearch,serverSearch);
  const [revision,setRevision]=useState(0),[view,setView]=useState(null);
  const query=new URLSearchParams(search??"");
  const number=query.get("id")??"";
  const from=query.get("from");
  const historyReturn=from?.startsWith("/kitchen/station-history?")?from:null;
  const paymentReturn=from==="/kitchen/payment-attention"||from?.startsWith("/kitchen/payment-attention?")?from:null;
  const delayReturn=from==="/kitchen?view=pickup-delay"?from:null;
  const delayReportDate=from?.match(/^\/kitchen\/daily\?date=(\d{4}-\d{2}-\d{2})#pickup-delay-report$/)?.[1];
  const delayReportReturn=businessDayRange(delayReportDate)?from:null;
  const shiftDate=from?.match(/^\/kitchen\/shift-handoff\?date=(\d{4}-\d{2}-\d{2})$/)?.[1];
  const shiftReturn=businessDayRange(shiftDate)?from:null;
  const returnPath=historyReturn||paymentReturn||delayReturn||delayReportReturn||shiftReturn;
  const current=view?.number===number&&view.revision===revision?view:null;
  useEffect(()=>{
    if(!number)return;
    const controller=new AbortController();
    const staff=sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/order-detail?"+new URLSearchParams({id:number}),{
      headers:staff?{Authorization:"Bearer "+staff}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(order=>{
      if(!controller.signal.aborted)setView({number,revision,order});
    }).catch(failure=>{
      if(!controller.signal.aborted)setView({number,revision,denied:failure.status===403,
        error:failure.name==="TimeoutError"?"查詢餐單逾時，請重新查詢。":failure.message});
    });
    return ()=>controller.abort();
  },[number,revision]);

  return <><Header/><main className="shell section dailyOperations">
    <div className="actions">
      <a className="textLink" href="/kitchen">返回店家接單台</a>
      {historyReturn&&<a className="textLink" href={historyReturn}>返回分站批次紀錄</a>}
      {paymentReturn&&<a className="textLink" href={paymentReturn}>返回待核對付款</a>}
      {delayReturn&&<a className="textLink" href={delayReturn}>返回待確認延誤</a>}
      {delayReportReturn&&<a className="textLink" href={delayReportReturn}>返回延誤通知交班</a>}
      {shiftReturn&&<a className="textLink" href={shiftReturn}>返回交班待辦</a>}
    </div>
    <h1>查詢餐單紀錄</h1>
    <form className="actions dailyDate" action={pagePath} key={number}>
      <label>餐號<input name="id" type="text" required inputMode="numeric" pattern="[0-9]+" maxLength={16} defaultValue={number}/></label>
      {returnPath&&<input type="hidden" name="from" value={returnPath}/>}
      <button className="primary">查詢餐單</button>
    </form>
    {number&&!current&&<p role="status">正在查詢餐單…</p>}
    {current?.error&&<p role="alert" className="error">{current.error}</p>}
    {current?.denied&&<a className="outline" target="_top"
      href={"/signin-with-chatgpt?return_to="+encodeURIComponent(pagePath+(search??""))}>使用 ChatGPT 登入</a>}
    {current?.order&&<OrderDetails order={current.order} query={query}/>}
    {current&&!current.denied&&<button className="outline orderLookupRefresh" onClick={()=>setRevision(value=>value+1)}>重新查詢</button>}
  </main><Footer/></>;
}
