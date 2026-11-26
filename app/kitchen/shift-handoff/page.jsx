"use client";

import {useEffect,useState} from "react";
import {Footer,Header,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {businessDayRange} from "../../../lib/business-day.mjs";
import {numberOf} from "../../../lib/menu.mjs";
import {environmentLabel,methods,paymentStates} from "../../../lib/payments.mjs";
import {pickupRosterPath,pickupRosterReviews,pickupWindow} from "../../../lib/pickup-slots.mjs";
import "./shift-handoff.css";

const pagePath="/kitchen/shift-handoff";
const timeFormat=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"short",hourCycle:"h23"});
const datePath=date=>pagePath+"?"+new URLSearchParams({date});
const time=at=><time dateTime={new Date(at).toISOString()}>{timeFormat.format(at)}</time>;

function Group({id,title,caption,group,href,action,secondary,children}){
  const {total:count}=group;
  return <section className="sheet shiftHandoffGroup" aria-labelledby={id}>
    <h2 id={id}>{title}<span>{count} 筆</span></h2>
    <p>{caption}</p>
    {group.orders.length?<ul className="shiftHandoffOrders">{children}</ul>:<p>目前沒有待辦</p>}
    {count>group.orders.length&&<p>顯示前 {group.orders.length} 筆</p>}
    <div className="actions">
      <a className="textLink" href={href}>{action}</a>
      {secondary}
    </div>
  </section>;
}

function PickupGroup({review,group,date}){
  return <Group id={"handoff-pickup-"+review} title={pickupRosterReviews[review]}
    caption="依預約取餐日期" group={group} href={pickupRosterPath(date,null,review)} action={review==="unreported"?"開啟未回報清單":"開啟已到店清單"}>
    {group.orders.map(({id,pickupSlot,dueAt})=><li key={id}>
      <a className="textLink" href={"/kitchen?"+new URLSearchParams({booking:numberOf(id),date,slot:String(pickupSlot),review})}>
        取餐 #{numberOf(id)}</a>
      <small>{pickupWindow(pickupSlot)} · {time(dueAt)} 起需追蹤</small>
    </li>)}
  </Group>;
}

function PaymentGroup({group,date,capturedAt}){
  const due=group.followUpsDue??0;
  return <Group id="handoff-payments" title="線上付款待核對"
    caption={"跨日 · 依每張餐單最新付款嘗試 · 已到追蹤時間 "+due+" 筆"} group={group}
    href="/kitchen/payment-attention" action="開啟付款核對"
    secondary={due>0&&<a className="textLink" href="/kitchen/payment-attention?followUp=due">開啟已到期追蹤</a>}>
    {group.orders.map(({id,method,environment,state,startedAt,attemptId,followUpAt})=>{
      const overdue=followUpAt!==undefined&&followUpAt<=capturedAt;
      const query={id:numberOf(id),from:datePath(date),
        ...(followUpAt&&attemptId?{attempt:String(attemptId),notes:"1"}:{})};
      return <li key={id}>
        <a className="textLink" href={"/kitchen/order-detail?"+new URLSearchParams(query)+(query.notes?"#payment-attention-notes":"")}>
          餐單 #{numberOf(id)}</a>
        <small>{methods[method]??"付款方式未記錄"} · {paymentStates[state]}{environmentLabel(environment)?" · "+environmentLabel(environment):""}</small>
        <small>{startedAt>0?time(startedAt):"付款開始時間未記錄"}</small>
        {followUpAt!==undefined&&<small className={overdue?"shiftHandoffDue":undefined}>
          {overdue?"已到追蹤時間":"下次追蹤"} {time(followUpAt)}
        </small>}
      </li>;
    })}
  </Group>;
}

export default function ShiftHandoff(){
  const today=useBusinessToday();
  const [selection,setSelection]=useState(null);
  const [view,setView]=useState(null),[revision,setRevision]=useState(0);
  useEffect(()=>{
    const dates=new URLSearchParams(window.location.search).getAll("date");
    setSelection({value:dates[0]??null,duplicate:dates.length>1});
  },[]);
  const date=selection?.value??today;
  const valid=selection&&!selection.duplicate&&Boolean(businessDayRange(date));
  useEffect(()=>{
    if(!valid)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api"+datePath(date),{
      headers:key?{Authorization:"Bearer "+key}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(snapshot=>{
      if(!controller.signal.aborted)setView({date,revision,snapshot});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({date,revision,denied:error.status===403,
        error:error.name==="TimeoutError"?"讀取交班待辦逾時，請重新擷取。":error.message});
    });
    return ()=>controller.abort();
  },[date,valid,revision]);
  const current=view?.date===date&&view.revision===revision?view:null;
  const snapshot=current?.snapshot;
  return <><Header/><main className="shell section shiftHandoff">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>交班待辦</h1>
    <form action={pagePath} className="actions shiftHandoffFilters" key={date}>
      <label>交班日期<input type="date" name="date" required defaultValue={businessDayRange(date)?date:today}/></label>
      <button type="submit" className="outline">套用日期</button>
      <button type="button" className="outline" disabled={!valid||!current}
        onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
    </form>
    {selection&&!valid&&<p className="error" role="alert">請選擇有效的交班日期。</p>}
    {valid&&!current&&<p role="status">正在擷取交班待辦…</p>}
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="primary" href={"/signin-with-chatgpt?return_to="+encodeURIComponent(datePath(date))} target="_top">
      使用 ChatGPT 登入</a>}
    {snapshot&&<>
      <p className="shiftHandoffTime" role="status">台灣擷取時間 {time(snapshot.capturedAt)}</p>
      <div className="shiftHandoffGrid">
        <PickupGroup review="unreported" date={date} group={snapshot.pickup.unreported}/>
        <PickupGroup review="arrived" date={date} group={snapshot.pickup.arrived}/>
        <PaymentGroup group={snapshot.payments} date={date} capturedAt={snapshot.capturedAt}/>
        <Group id="handoff-cash" title="已交餐、現金缺登"
          caption="依餐單成立日期" group={snapshot.cash} href={"/kitchen/daily?"+new URLSearchParams({date})} action="開啟日結核對">
          {snapshot.cash.orders.map(({id,createdAt})=><li key={id}>
            <a className="textLink" href={"/kitchen?"+new URLSearchParams({paymentReview:numberOf(id),date})}>餐單 #{numberOf(id)}</a>
            <small>{time(createdAt)} 成立</small>
          </li>)}
        </Group>
      </div>
    </>}
  </main><Footer/></>;
}
