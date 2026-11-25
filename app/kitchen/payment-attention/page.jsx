"use client";

import {useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,request} from "../../shared";
import {labels,numberOf} from "../../../lib/menu.mjs";
import {environmentLabel,methods,onlinePaymentEnvironments,paymentAttentionStates,paymentCheckMessage,
  paymentStates} from "../../../lib/payments.mjs";
import "../daily/daily.css";
import "./payment-attention.css";

const path="/kitchen/payment-attention",endpoint="/api/kitchen/payment-attention";
const time=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"short",hourCycle:"h23"});
const timeLabel=at=><time dateTime={new Date(at).toISOString()}>{time.format(at)}</time>;
const environmentName={demo:"示範環境",sandbox:"TapPay 測試環境",production:"正式付款"};
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;
function subscribe(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}
function staffHeaders(){
  const staff=sessionStorage.getItem("he-ri-staff");
  return staff?{Authorization:"Bearer "+staff}:{};
}

function Filter({name,title,choices,current}){
  return <label>{title}<select name={name} defaultValue={current??""}>
    <option value="">全部</option>
    {choices.map(([value,label])=><option value={value} key={value}>{label}</option>)}
  </select></label>;
}

function PaymentRow({order,capturedAt,returnPath,onCheck,checking}){
  const number=numberOf(order.id);
  const wait=Math.max(0,Math.floor((capturedAt-order.startedAt)/60_000));
  const overdue=order.state==="pending"&&order.paymentDueAt!==null&&order.paymentDueAt<=capturedAt;
  return <li className="sheet paymentAttentionRow">
    <h2><a href={"/kitchen/order-detail?"+new URLSearchParams({id:number,from:returnPath})}>餐單 #{number}</a></h2>
    <p><strong>{methods[order.method]??"付款方式未記錄"} · {paymentStates[order.state]}</strong>
      {" · NT$ "+order.total.toLocaleString("zh-TW")}</p>
    <p>{environmentLabel(order.environment)||"環境未記錄"} · {labels[order.status]??order.status}</p>
    <p>{order.startedAt>0?<>付款開始 {timeLabel(order.startedAt)} · 已等 {wait} 分鐘</>:"付款開始時間未記錄"}</p>
    {overdue&&<p role="note">已到保留時間，付款仍待確認。</p>}
    <p>{order.checkedAt===null?"尚未發出金流查詢":<>上次發出查詢 {timeLabel(order.checkedAt)}</>}</p>
    {order.canCheck?<button className="outline" aria-label={"查詢餐單 "+number+" 的金流"} disabled={checking!==null}
      onClick={()=>onCheck(order.id)}>{checking===order.id?"正在查詢金流…":"查詢金流"}</button>:
      ["sandbox","production"].includes(order.environment)&&<p>請在對應的金流後台核對。</p>}
  </li>;
}

export default function PaymentAttention(){
  const search=useSyncExternalStore(subscribe,browserSearch,serverSearch);
  const [view,setView]=useState(null),[revision,setRevision]=useState(0),[action,setAction]=useState(null);
  const params=new URLSearchParams(search??"");
  const current=view?.search===search&&view.revision===revision?view:null;
  const activeAction=action?.search===search?action:null;
  const report=current?.report;
  const refresh=()=>setRevision(value=>value+1);
  useEffect(()=>{
    if(search===null)return;
    const controller=new AbortController();
    request(endpoint+search,{headers:staffHeaders(),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])}).then(report=>{
      if(!controller.signal.aborted)setView({search,revision,report});
    }).catch(failure=>{
      if(!controller.signal.aborted)setView({search,revision,denied:failure.status===403,
        error:failure.name==="TimeoutError"?"讀取待核對付款逾時，請重新擷取。":failure.message});
    });
    return ()=>controller.abort();
  },[search,revision]);

  async function check(id){
    if(activeAction?.checking)return;
    setAction({search,id,checking:true});
    try{
      const result=await request("/api/kitchen/payment",{method:"PATCH",headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify({id}),signal:AbortSignal.timeout(30_000)});
      setAction({search,id,message:paymentCheckMessage(result)});
      refresh();
    }catch{
      setAction({search,id,message:"無法完成金流查詢，請稍後再試。",error:true});
    }
  }

  function pageUrl(after){
    const next=new URLSearchParams(search??"");
    next.delete("after");
    if(after)next.set("after",after);
    return path+(next.size?"?"+next:"");
  }

  return <><Header/><main className="shell section dailyOperations paymentAttention">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>線上付款待核對</h1>
    <p>依付款開始時間，查看確認中或已授權待請款的付款。</p>
    <form className="actions dailyDate" action={path} key={search}>
      <Filter name="state" title="付款狀態" choices={paymentAttentionStates.map(value=>[value,paymentStates[value]])} current={params.get("state")}/>
      <Filter name="method" title="付款工具" choices={Object.entries(methods).filter(([key])=>key!=="cash")} current={params.get("method")}/>
      <Filter name="environment" title="金流環境" choices={onlinePaymentEnvironments.map(value=>[value,environmentName[value]])} current={params.get("environment")}/>
      <button className="outline">套用篩選</button>
    </form>
    {activeAction?.message&&<p role={activeAction.error?"alert":"status"} className={activeAction.error?"error":undefined}>
      {"餐單 #"+numberOf(activeAction.id)+" · "+activeAction.message}</p>}
    {search!==null&&!current&&<p role="status">正在讀取待核對付款…</p>}
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="outline" target="_top"
      href={"/signin-with-chatgpt?return_to="+encodeURIComponent(path+(search??""))}>使用 ChatGPT 登入</a>}
    {current&&!current.denied&&<div className="actions dailyCapture">
      {report&&<p>擷取時間 {timeLabel(report.capturedAt)}</p>}
      <button className="outline" onClick={refresh} disabled={activeAction?.checking}>重新擷取</button>
    </div>}
    {report&&<section aria-label="待核對付款清單">
      {report.orders.length>0?<ul className="paymentAttentionList">
        {report.orders.map(order=><PaymentRow key={order.id} order={order} capturedAt={report.capturedAt}
          returnPath={path+(search??"")} onCheck={check} checking={activeAction?.checking?activeAction.id:null}/>)}
      </ul>:<p>目前沒有符合條件的待核對付款。</p>}
      {(params.has("after")||report.nextAfter)&&<nav className="actions paymentAttentionPages" aria-label="待核對付款分頁">
        {params.has("after")&&<a className="outline" href={pageUrl(null)}>返回最早一頁</a>}
        {report.nextAfter&&<a className="outline" href={pageUrl(report.nextAfter)}>查看下一頁</a>}
      </nav>}
    </section>}
  </main><Footer/></>;
}
