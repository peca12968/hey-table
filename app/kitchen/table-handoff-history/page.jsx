"use client";

import {Fragment,useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,request} from "../../shared";
import {ProgressTime} from "../../order-progress";
import {useBusinessToday} from "../../use-business-today.mjs";
import {numberOf,tables} from "../../../lib/menu.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import "../daily/daily.css";

const pagePath="/kitchen/table-handoff-history",endpoint="/api"+pagePath;
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;
function subscribeToSearch(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}

export default function TableHandoffHistory(){
  const today=useBusinessToday();
  const search=useSyncExternalStore(subscribeToSearch,browserSearch,serverSearch);
  const [view,setView]=useState(null),[revision,setRevision]=useState(0);
  const query=new URLSearchParams(search??"");
  if(!query.has("date")&&today)query.set("date",today);
  const date=query.get("date")??"",table=query.get("table")??"",id=query.get("id")??"";
  const ready=search!==null&&query.has("date"),queryString=query.toString();
  const current=view?.query===queryString&&view.revision===revision?view:null;
  const report=current?.report;
  const currentPage=pagePath+"?"+queryString;

  useEffect(()=>{
    if(!ready)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request(endpoint+"?"+queryString,{
      headers:key?{Authorization:"Bearer "+key}:{},
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(report=>{
      if(!controller.signal.aborted)setView({query:queryString,revision,report});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({query:queryString,revision,denied:error.status===403,
        error:error.name==="TimeoutError"?"讀取交餐紀錄逾時，請重新擷取。":error.message});
    });
    return ()=>controller.abort();
  },[queryString,ready,revision]);

  const pages=new URLSearchParams(query);
  pages.delete("before");
  const first=pagePath+"?"+pages;
  if(report?.nextBefore)pages.set("before",report.nextBefore);
  const next=report?.nextBefore?pagePath+"?"+pages:null;

  return <><Header/><main className="shell section dailyOperations">
    <a className="textLink dailyControl" href="/kitchen">返回店家接單台</a>
    <h1>同桌交餐紀錄</h1>
    <form className="actions dailyDate dailyControl" action={pagePath} key={date+"|"+table+"|"+id}>
      <label>交餐日期（台灣）<input type="date" name="date" defaultValue={date} required/></label>
      <label>桌號<select name="table" defaultValue={table}>
        <option value="">全部桌號</option>
        {tables.map(value=><option key={value} value={value}>{value} 桌</option>)}
      </select></label>
      <label>餐號<input name="id" inputMode="numeric" pattern="[0-9]+" maxLength={16} defaultValue={id}/></label>
      <button className="primary">查詢交餐紀錄</button>
    </form>
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="outline dailyControl" target="_top"
      href={"/signin-with-chatgpt?return_to="+encodeURIComponent(currentPage)}>使用 ChatGPT 登入</a>}
    {ready&&!current&&<p role="status">正在讀取交餐紀錄…</p>}
    {report&&<section className="sheet tableHandoff" aria-labelledby="handoff-results">
      <h2 id="handoff-results">{report.date} · {report.table?report.table+" 桌":"全部桌號"}{report.id?" · #"+numberOf(report.id):""}</h2>
      <p>符合 {report.summary.batches} 批，共 {report.summary.orders} 張餐單。</p>
      <div className="actions dailyControl">
        <button className="outline" onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
        <button className="outline" onClick={()=>downloadJson("hey-table-handoff-history-",report.capturedAt,report)}>下載本頁 JSON</button>
      </div>
      <p className="muted">擷取時間 <ProgressTime at={report.capturedAt}/></p>
      {report.batches.length?<ul className="tableHandoffOrders">
        {report.batches.map(batch=><li key={batch.operationId}>
          <div className="actions"><strong>{batch.table} 桌</strong><span>{batch.completed} 張餐單</span><ProgressTime at={batch.completedAt}/></div>
          <p className="orderNoteText">收據編號 {batch.operationId}</p>
          <p>{batch.orderIds.map((orderId,index)=><Fragment key={orderId}>{index?"、":""}
            <a href={"/kitchen/order-detail?"+new URLSearchParams({id:numberOf(orderId),from:currentPage})}>
              #{numberOf(orderId)}</a></Fragment>)}</p>
        </li>)}
      </ul>:<p>此頁沒有同桌交餐收據。</p>}
      {(query.has("before")||next)&&<nav className="actions dailyControl" aria-label="交餐紀錄分頁">
        {query.has("before")&&<a className="outline" href={first}>回到第一頁</a>}
        {next&&<a className="outline" href={next}>下一頁</a>}
      </nav>}
    </section>}
  </main><Footer/></>;
}
