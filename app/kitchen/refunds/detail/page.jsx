"use client";

import {useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,request} from "../../../shared";
import {businessDayRange} from "../../../../lib/business-day.mjs";
import {downloadJson} from "../../../../lib/download-json.mjs";
import {labels,numberOf} from "../../../../lib/menu.mjs";
import {methods,paymentStates} from "../../../../lib/payments.mjs";
import "../../daily/daily.css";

const taipei=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
const amount=value=>"NT$ "+value.toLocaleString("zh-TW");
const statusLabel=value=>value==="completed"?"已交餐":labels[value]??"未記錄";
const sources={recorded:"退款紀錄",cancellation_history:"舊餐單取消紀錄",legacy_payment:"舊付款紀錄"};
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;
function subscribeToSearch(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}

function Timestamp({value}){
  return value===null?"未記錄":<time dateTime={new Date(value).toISOString()}>{taipei.format(value)}</time>;
}

export default function RefundDetail(){
  const search=useSyncExternalStore(subscribeToSearch,browserSearch,serverSearch);
  const [view,setView]=useState(null),[revision,setRevision]=useState(0);
  const query=new URLSearchParams(search??"");
  const number=query.get("id")??"",id=Number(number),date=query.get("date");
  const valid=query.getAll("id").length===1&&/^\d+$/.test(number)&&Number.isSafeInteger(id)&&id>0;
  const back="/kitchen/refunds"+(businessDayRange(date)?"?"+new URLSearchParams({date}):"");
  useEffect(()=>{
    if(!valid)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/demo-refund-detail?"+new URLSearchParams({id:String(id)}),{
      headers:key?{Authorization:"Bearer "+key}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]),
    }).then(report=>{
      if(!controller.signal.aborted)setView({id,revision,report});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({id,revision,denied:error.status===403,
        error:error.name==="TimeoutError"?"讀取退款明細逾時，請重新讀取。":error.message});
    });
    return ()=>controller.abort();
  },[id,revision,valid]);
  const current=view?.id===id&&view.revision===revision?view:null;
  const report=valid?current?.report:null;
  const {order,refund}=report??{};

  return <><Header/><main className="shell section dailyOperations">
    <a className="textLink dailyControl" href={back}>返回示範退款交班紀錄</a>
    <h1>示範退款餐單</h1>
    {search!==null&&!valid&&<p className="error" role="alert">請輸入有效的餐號。</p>}
    {valid&&!current&&<p role="status">正在讀取退款明細…</p>}
    {valid&&current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="outline dailyControl" href={"/signin-with-chatgpt?return_to="+
      encodeURIComponent("/kitchen/refunds/detail"+search)} target="_top">使用 ChatGPT 登入</a>}
    {valid&&current?.error&&!current.denied&&<button className="outline dailyControl" onClick={()=>setRevision(value=>value+1)}>重新讀取</button>}
    {report&&<>
      <div className="actions dailyCapture">
        <p>擷取時間（台灣） <Timestamp value={report.capturedAt}/></p>
        <button className="outline dailyControl" onClick={()=>window.print()}>列印退款餐單</button>
        <button className="outline dailyControl" onClick={()=>downloadJson("hey-table-demo-refund-"+numberOf(order.id)+"-",report.capturedAt,report)}>下載退款餐單 JSON</button>
      </div>
      <div className="kGrid">
        <section className="sheet dailyChannel" aria-label="餐單資料">
          <h2>#{numberOf(order.id)}</h2>
          <dl>
            <div><dt>成立時間</dt><dd><Timestamp value={order.createdAt}/></dd></div>
            <div><dt>用餐方式</dt><dd>{order.mode==="table"?"掃碼內用":"自取"}</dd></div>
            <div><dt>目前餐單狀態</dt><dd>{statusLabel(order.status)}</dd></div>
            <div><dt>原餐單金額</dt><dd>{amount(order.total)}</dd></div>
          </dl>
        </section>
        <section className="sheet dailyChannel" aria-label="退款資料">
          <h2>退款資料</h2>
          <dl>
            <div><dt>付款方式</dt><dd>{methods[order.paymentMethod]??"未記錄"}</dd></div>
            <div><dt>目前付款狀態</dt><dd>{paymentStates[order.paymentState]??"未記錄"}</dd></div>
            <div><dt>退款前餐單狀態</dt><dd>{statusLabel(refund.previousStatus)}</dd></div>
            <div><dt>退款時間</dt><dd><Timestamp value={refund.refundedAt}/></dd></div>
            <div><dt>示範退款金額</dt><dd>{amount(refund.amount)}</dd></div>
            <div><dt>資料來源</dt><dd>{sources[refund.source]}</dd></div>
          </dl>
        </section>
      </div>
      {order.items.length>0&&<section className="sheet dailyDishes" aria-label="原餐單品項">
        <h2>原餐單品項</h2>
        <ul className="orderLines">{order.items.map(({name,qty},index)=><li key={index}><span>{name}</span><strong>× {qty}</strong></li>)}</ul>
      </section>}
    </>}
  </main><Footer/></>;
}
