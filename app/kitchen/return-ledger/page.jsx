"use client";

import {useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {businessDayRange} from "../../../lib/business-day.mjs";
import {numberOf} from "../../../lib/menu.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import "../daily/daily.css";
import "./return-ledger.css";

const pagePath="/kitchen/return-ledger",endpoint="/api/kitchen/return-ledger-report";
const localTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",timeStyle:"medium",hourCycle:"h23"});
const amount=value=>"NT$ "+value.toLocaleString("zh-TW");
const browserDate=()=>new URLSearchParams(window.location.search).get("date")??"";
const serverDate=()=>null;
function subscribeToDate(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}

export default function ReturnLedger(){
  const today=useBusinessToday();
  const linkedDate=useSyncExternalStore(subscribeToDate,browserDate,serverDate);
  const [view,setView]=useState(null),[revision,setRevision]=useState(0);
  const date=linkedDate===null?"":businessDayRange(linkedDate)?linkedDate:today;
  const current=view?.date===date&&view.revision===revision?view:null;
  const report=current?.report,totals=report?.totals;
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController(),staff=sessionStorage.getItem("he-ri-staff");
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]);
    request(endpoint+"?"+new URLSearchParams({date}),{headers:staff?{Authorization:"Bearer "+staff}:{},signal}).then(report=>{
      if(!controller.signal.aborted)setView({date,revision,report});
    }).catch(failure=>{
      if(!controller.signal.aborted)setView({date,revision,denied:failure.status===403,
        error:failure.name==="TimeoutError"?"讀取試算交班逾時，請重新擷取。":failure.message});
    });
    return ()=>controller.abort();
  },[date,revision]);

  return <><Header/><main className="shell section dailyOperations">
    <a className="textLink dailyControl" href="/kitchen">返回店家接單台</a>
    <h1>退餐試算交班</h1>
    <p>按台灣日期核對試算簿的登記及撤銷。</p>
    <form className="actions dailyDate dailyControl" action={pagePath} key={date}>
      <label>試算日期<input name="date" type="date" defaultValue={date} required/></label>
      <button className="outline">查詢日期</button>
    </form>
    {date&&!current&&<p role="status">正在讀取試算交班…</p>}
    {current?.error&&<p role="alert" className="error">{current.error}</p>}
    {current?.denied&&<a className="outline dailyControl" target="_top" href={"/signin-with-chatgpt?return_to="+
      encodeURIComponent(pagePath+"?"+new URLSearchParams({date}))}>使用 ChatGPT 登入</a>}
    {current?.error&&!current.denied&&<button className="outline" onClick={()=>setRevision(value=>value+1)}>重新擷取</button>}
    {report&&<>
      <div className="actions dailyCapture">
        <p>{report.date} · 擷取時間 <time dateTime={new Date(report.capturedAt).toISOString()}>{localTime.format(report.capturedAt)}</time></p>
        <button className="outline dailyControl" onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
        <button className="outline dailyControl" onClick={()=>window.print()}>列印試算交班</button>
        <button className="outline dailyControl" onClick={()=>downloadJson("hey-table-return-ledger-"+report.date+"-",report.capturedAt,report)}>下載試算交班 JSON</button>
      </div>
      <section className="sheet returnLedgerReport" aria-labelledby="return-ledger-events">
        <h2 id="return-ledger-events">{report.date} 試算簿異動</h2>
        <dl className="returnLedgerTotals">
          <div><dt>登記 {totals.recordedCount} 筆</dt><dd>{amount(totals.recordedAmount)}</dd></div>
          <div><dt>撤銷 {totals.voidedCount} 筆</dt><dd>{amount(totals.restoredAmount)}</dd></div>
          <div><dt>當日淨異動</dt><dd>{amount(totals.netAmount)}</dd></div>
        </dl>
        {report.events.length>0?<ol className="returnLedgerEvents">{report.events.map(event=><li key={event.orderId+":"+event.revision}>
          <div className="actions">
            <a href={"/kitchen?"+new URLSearchParams({returnId:numberOf(event.orderId)})+"#return-receipt"}>餐單 #{numberOf(event.orderId)}</a>
            <strong>{event.kind==="voided"?"撤銷第 "+event.targetRevision+" 筆":"登記第 "+event.revision+" 筆"} · {amount(event.amount)}</strong>
            <time dateTime={new Date(event.recordedAt).toISOString()}>{localTime.format(event.recordedAt)}</time>
          </div>
          {event.reason&&<p>{event.reason}</p>}
        </li>)}</ol>:<p>這一天沒有試算簿異動。</p>}
      </section>
    </>}
  </main><Footer/></>;
}
