"use client";

import {Fragment,useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {stationLabels} from "../../../lib/kitchen-timing.mjs";
import {numberOf} from "../../../lib/menu.mjs";
import "../daily/daily.css";

const pagePath="/kitchen/station-history",endpoint="/api/kitchen/station-work/history";
const historyTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",timeStyle:"medium",hourCycle:"h23"});
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;
function subscribeToSearch(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}

export default function StationHistory(){
  const today=useBusinessToday();
  const search=useSyncExternalStore(subscribeToSearch,browserSearch,serverSearch);
  const [view,setView]=useState(null),[revision,setRevision]=useState(0);
  const query=new URLSearchParams(search??"");
  if(!query.has("date")&&today)query.set("date",today);
  const date=query.get("date")??"",station=query.get("station")??"",id=query.get("id")??"";
  const ready=search!==null&&query.has("date");
  const queryString=query.toString();
  const current=view?.search===queryString&&view.revision===revision?view:null;
  const report=current?.report;

  useEffect(()=>{
    if(!ready)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request(endpoint+"?"+queryString,{
      headers:key?{Authorization:"Bearer "+key}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(report=>{
      if(!controller.signal.aborted)setView({search:queryString,revision,report});
    }).catch(failure=>{
      if(!controller.signal.aborted)setView({search:queryString,revision,denied:failure.status===403,
        error:failure.name==="TimeoutError"?"讀取批次紀錄逾時，請重新擷取。":failure.message});
    });
    return ()=>controller.abort();
  },[queryString,ready,revision]);

  const ordered=new URLSearchParams(query);
  ordered.delete("before");
  const firstPage=pagePath+"?"+ordered;
  if(report?.nextBefore)ordered.set("before",report.nextBefore);
  const nextPage=report?.nextBefore?pagePath+"?"+ordered:null;

  return <><Header/><main className="shell section dailyOperations">
    <a className="textLink dailyControl" href={"/kitchen/station-work"+(station?"?"+new URLSearchParams({station}):"")}>返回分站看板</a>
    <h1>分站批次紀錄</h1>
    <p>依台灣時間查閱已回報備妥的批次。</p>
    <form className="actions dailyDate dailyControl stationHistoryFilters" action={pagePath}
      key={date+"|"+station+"|"+id}>
      <label>回報日期<input type="date" name="date" defaultValue={date} required/></label>
      <label>工作站<select name="station" defaultValue={station}>
        <option value="">全部分站</option>
        {Object.entries(stationLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>餐號<input name="id" type="text" inputMode="numeric" pattern="[0-9]+" maxLength={16} defaultValue={id}/></label>
      <button className="primary">查詢紀錄</button>
    </form>
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="outline dailyControl" target="_top"
      href={"/signin-with-chatgpt?return_to="+encodeURIComponent(pagePath+"?"+queryString)}>使用 ChatGPT 登入</a>}
    {ready&&!current&&<p role="status">正在讀取批次紀錄…</p>}
    {report&&<section className="sheet tableHandoff" aria-labelledby="station-history-results">
      <div className="actions">
        <h2 id="station-history-results">{report.date} · {stationLabels[report.station]??"全部分站"}{report.id?" · #"+numberOf(report.id):""}</h2>
        <button className="outline" onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
      </div>
      {report.batches.length>0?<ul className="tableHandoffOrders">
        {report.batches.map(batch=><li key={batch.operationId}>
          <div className="actions">
            <time dateTime={new Date(batch.recordedAt).toISOString()}>{historyTime.format(batch.recordedAt)}</time>
            <strong>{stationLabels[batch.station]}</strong>
            <span>{batch.completed} 張餐單</span>
          </div>
          <p>{batch.orderIds.map((orderId,index)=><Fragment key={orderId}>{index>0?"、":""}<a className="stationHistoryOrder"
            href={"/kitchen/order-detail?"+new URLSearchParams({id:numberOf(orderId),from:pagePath+"?"+queryString})}>
            #{numberOf(orderId)}</a></Fragment>)}</p>
        </li>)}
      </ul>:<p>沒有符合條件的批次紀錄。</p>}
      {(query.has("before")||nextPage)&&<nav className="actions" aria-label="批次紀錄分頁">
        {query.has("before")&&<a className="outline" href={firstPage}>回到第一頁</a>}
        {nextPage&&<a className="outline" href={nextPage}>下一頁</a>}
      </nav>}
    </section>}
  </main><Footer/></>;
}
