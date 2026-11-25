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
const historyEndpoint="/api/kitchen/return-ledger-review-history";
const localTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",timeStyle:"medium",hourCycle:"h23"});
const localDateTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium",hourCycle:"h23"});
const amount=value=>"NT$ "+value.toLocaleString("zh-TW");
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;
function subscribeToLocation(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}

function historyQuery(date,before){
  const params=new URLSearchParams({date,history:"1"});
  if(before!==null)params.set("before",before);
  return params;
}

function reviewedReportUrl(date,fingerprint,historyBefore){
  const params=historyBefore===undefined?new URLSearchParams({date}):historyQuery(date,historyBefore);
  params.set("review",fingerprint);
  return pagePath+"?"+params;
}

function ReviewRecord({review,date,historyBefore}){
  return <>
    <p><time dateTime={new Date(review.reviewedAt).toISOString()}>{localDateTime.format(review.reviewedAt)}</time>
      {" · 核對 "+review.eventCount+" 筆 · 淨異動 "+amount(review.netAmount)}</p>
    {review.note&&<p className="returnReviewNote">{review.note}</p>}
    {date&&<a className="textLink dailyControl" href={reviewedReportUrl(date,review.fingerprint,historyBefore)}>
      開啟已確認報表
    </a>}
  </>;
}

function ReviewHistory({history,before}){
  const {date,reviews,nextBefore}=history;
  return <section className="sheet returnLedgerReport returnReview" aria-labelledby="return-ledger-history">
    <h2 id="return-ledger-history">{date} 交班確認</h2>
    {reviews.length>0?<ol className="returnLedgerEvents">
      {reviews.map(review=><li key={review.fingerprint}><ReviewRecord review={review} date={date} historyBefore={before}/></li>)}
    </ol>:<p>{before===null?"這一天還沒有交班確認。":"已到最早的交班確認。"}</p>}
    {(before!==null||nextBefore)&&<nav className="actions returnReviewPages" aria-label="確認紀錄分頁">
      {before!==null&&<a className="outline" href={pagePath+"?"+historyQuery(date,null)}>返回最新確認</a>}
      {nextBefore&&<a className="outline" href={pagePath+"?"+historyQuery(date,nextBefore)}>查看更早的確認</a>}
    </nav>}
  </section>;
}

function HandoffReview({report,onSave}){
  const [note,setNote]=useState(""),[submission,setSubmission]=useState(null);
  const [latest,...previous]=report.reviews;
  const checked=latest?.fingerprint===report.fingerprint;
  const canConfirm=businessDayRange(report.date)[0]<=report.capturedAt;
  async function save(event){
    event.preventDefault();
    if(checked||submission?.pending||submission?.conflict)return;
    const sentNote=submission?.sentNote??note.trim();
    setSubmission({pending:true,sentNote});
    const staff=sessionStorage.getItem("he-ri-staff");
    try{
      const saved=await request(endpoint,{method:"POST",signal:AbortSignal.timeout(10_000),
        headers:{"Content-Type":"application/json",...(staff?{Authorization:"Bearer "+staff}:{})},
        body:JSON.stringify({date:report.date,fingerprint:report.fingerprint,capturedAt:report.capturedAt,note:sentNote})});
      onSave(saved);
      setSubmission(null);
    }catch(failure){
      const conflict=failure.status===409;
      const definitive=failure.status>=400&&failure.status<500;
      setSubmission({conflict,sentNote:definitive?null:sentNote,
        error:definitive?failure.message:"尚未收到確認結果，請重試同一份報表。"});
    }
  }

  return <section className="sheet returnLedgerReport returnReview" aria-labelledby="return-ledger-review">
    <h2 id="return-ledger-review">交班確認</h2>
    <p role="status">{checked?"這份報表已確認。":latest?"確認後已有試算異動，請重新核對。":"這份報表尚未確認。"}</p>
    {latest&&<ReviewRecord review={latest} date={report.date}/>}
    {!checked&&canConfirm&&<form className="dailyControl returnReviewForm" onSubmit={save}>
      <label>交班備註（選填）<textarea maxLength={160} rows={2} value={note}
        onChange={event=>setNote(event.target.value)} disabled={submission?.pending||submission?.sentNote!=null||submission?.conflict}/></label>
      {submission?.error&&<p className="error" role="alert">{submission.error}</p>}
      <button className="primary" disabled={submission?.pending||submission?.conflict}>
        {submission?.pending?"儲存中…":submission?.sentNote!=null?"重試確認同一份報表":"確認這份報表"}
      </button>
    </form>}
    {previous.length>0&&<details className="dailyControl">
      <summary>較早的確認紀錄（{previous.length} 筆）</summary>
      <ol>{previous.map(review=><li key={review.fingerprint}><ReviewRecord review={review} date={report.date}/></li>)}</ol>
    </details>}
    {latest&&<a className="textLink dailyControl" href={pagePath+"?"+historyQuery(report.date,null)}>查看完整確認紀錄</a>}
  </section>;
}

export default function ReturnLedger(){
  const today=useBusinessToday();
  const search=useSyncExternalStore(subscribeToLocation,browserSearch,serverSearch);
  const params=new URLSearchParams(search??"");
  const linkedDate=params.get("date"),reviewKey=params.get("review");
  const historyLinked=params.get("history")==="1",historyMode=historyLinked&&reviewKey===null;
  const before=params.get("before");
  const [view,setView]=useState(null),[revision,setRevision]=useState(0);
  const date=search===null?"":businessDayRange(linkedDate)?linkedDate:today;
  const query=new URLSearchParams({date});
  if(reviewKey!==null)query.set("review",reviewKey);
  if(historyMode&&before!==null)query.set("before",before);
  const requestUrl=(historyMode?historyEndpoint:endpoint)+"?"+query;
  const current=view?.url===requestUrl&&view.revision===revision?view:null;
  const report=historyMode?null:current?.data,totals=report?.totals;
  const signinQuery=historyLinked?historyQuery(date,before):query;
  if(historyLinked&&reviewKey!==null)signinQuery.set("review",reviewKey);
  const signinPath=pagePath+"?"+signinQuery;
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController(),staff=sessionStorage.getItem("he-ri-staff");
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]);
    request(requestUrl,{headers:staff?{Authorization:"Bearer "+staff}:{},signal}).then(data=>{
      if(!controller.signal.aborted)setView({url:requestUrl,revision,data});
    }).catch(failure=>{
      if(!controller.signal.aborted)setView({url:requestUrl,revision,denied:failure.status===403,
        permanent:[400,404,409].includes(failure.status),
        error:failure.name==="TimeoutError"?"讀取試算交班逾時，請重新擷取。":failure.message});
    });
    return ()=>controller.abort();
  },[date,requestUrl,revision]);

  function saveReview(saved){
    setView(latest=>{
      if(latest?.url!==requestUrl||latest.revision!==revision||latest.data?.fingerprint!==saved.fingerprint)return latest;
      const previous=latest.data.reviews.filter(review=>review.fingerprint!==saved.fingerprint);
      return {...latest,data:{...latest.data,reviews:[saved,...previous.slice(0,9)]}};
    });
  }

  return <><Header/><main className="shell section dailyOperations">
    <a className="textLink dailyControl" href="/kitchen">返回店家接單台</a>
    <h1>{historyMode?"退餐交班確認紀錄":reviewKey===null?"退餐試算交班":"已確認的退餐試算報表"}</h1>
    {(historyMode||reviewKey!==null)&&date&&<a className="textLink dailyControl" href={pagePath+"?"+new URLSearchParams({date})}>返回當日交班</a>}
    {historyLinked&&reviewKey!==null&&date&&<a className="textLink dailyControl returnHistoryLink" href={pagePath+"?"+historyQuery(date,before)}>返回確認紀錄</a>}
    {!historyMode&&reviewKey===null&&<form className="actions dailyDate dailyControl" action={pagePath} key={date}>
      <label>試算日期<input name="date" type="date" defaultValue={date} required/></label>
      <button className="outline">查詢日期</button>
    </form>}
    {date&&!current&&<p role="status">正在讀取試算交班…</p>}
    {current?.error&&<p role="alert" className="error">{current.error}</p>}
    {current?.denied&&<a className="outline dailyControl" target="_top" href={"/signin-with-chatgpt?return_to="+
      encodeURIComponent(signinPath)}>使用 ChatGPT 登入</a>}
    {current?.error&&!current.denied&&!current.permanent&&<button className="outline" onClick={()=>setRevision(value=>value+1)}>重新擷取</button>}
    {historyMode&&current?.data&&<ReviewHistory history={current.data} before={before}/>}
    {report&&<>
      <div className="actions dailyCapture">
        <p>{report.date} · {report.captureSource==="reconstructed"?"依確認時間還原":"擷取時間"} <time dateTime={new Date(report.capturedAt).toISOString()}>
          {report.review?localDateTime.format(report.capturedAt):localTime.format(report.capturedAt)}
        </time></p>
        {!report.review&&<button className="outline dailyControl" onClick={()=>setRevision(value=>value+1)}>重新擷取</button>}
        <button className="outline dailyControl" onClick={()=>window.print()}>列印試算交班</button>
        <button className="outline dailyControl" onClick={()=>downloadJson("hey-table-return-ledger-"+report.date+
          (report.review?"-confirmed-":"-"),report.capturedAt,report)}>下載試算交班 JSON</button>
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
      {report.review?<section className="sheet returnLedgerReport returnReview" aria-labelledby="return-ledger-review">
        <h2 id="return-ledger-review">交班確認</h2>
        <ReviewRecord review={report.review}/>
      </section>:<HandoffReview key={date+":"+revision} report={report} onSave={saveReview}/>}
    </>}
  </main><Footer/></>;
}
