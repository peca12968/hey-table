"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {downloadCsv} from "../../../lib/download-csv.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import {numberOf} from "../../../lib/menu.mjs";
import {methods,paymentStates} from "../../../lib/payments.mjs";
import {pickupWindow} from "../../../lib/pickup-slots.mjs";
import "./daily.css";

const captureTime = new Intl.DateTimeFormat("zh-TW", {
  timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"medium",
});
const statusFields = [
  ["orders","全部餐單"],["pending","待接單"],["preparing","製作中"],
  ["ready","待交餐"],["completed","已交餐"],["cancelled","已取消"],
];

function downloadPortions(report) {
  const capturedAt = new Date(report.capturedAt).toISOString();
  const rows = [["餐單日期","擷取時間 (UTC)","品項編號","餐點","自取份數","內用份數","合計份數"],
    ...report.items.map(({id,name,pickupQty,tableQty,qty})=>[report.date,capturedAt,id,name,pickupQty,tableQty,qty])];
  downloadCsv(rows,"hey-table-portions-"+report.date+"-"+capturedAt.replaceAll(":","-")+".csv");
}

function ChannelSummary({name,summary}) {
  return <section className="sheet dailyChannel">
    <h2>{name}</h2>
    <dl>
      {statusFields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{summary[key]} 張</dd></div>)}
      <div><dt>已交餐單金額</dt><dd>NT$ {summary.completedTotal.toLocaleString("zh-TW")}</dd></div>
    </dl>
  </section>;
}

const environmentNames={production:"正式付款",sandbox:"測試環境",demo:"示範模式",unknown:"環境未記錄"};
const paymentStateNames={...paymentStates,cashRecorded:"已登記現金",cashMissing:"未登記現金",unknown:"付款狀態未記錄"};

function PaymentSummary({summary}){
  return <section className="sheet dailyTiming" aria-labelledby="daily-payment-title">
    <h2 id="daily-payment-title">已交餐付款方式摘要</h2>
    {summary.completed===0?<p>這一天沒有已交餐單。</p>:<>
      <p>依餐單成立日統計原成交金額。共 {summary.completed} 張，{summary.needsReview} 張需核對。</p>
      <div className="dailyTimingGrid dailyPayment">
        {summary.groups.map(group=>{
          const name=methods[group.method]??"付款方式未記錄",environment=environmentNames[group.environment];
          return <article key={group.method+":"+group.environment} aria-label={[name,environment].filter(Boolean).join(" · ")}>
            <h3>{name}{environment&&<small> · {environment}</small>}</h3>
            <p>{group.orders} 張 · 原成交金額 NT$ {BigInt(group.completedTotal).toLocaleString("zh-TW")}</p>
            <dl>{Object.entries(group.statuses).map(([state,count])=>
              <div key={state}><dt>{paymentStateNames[state]}</dt><dd>{count} 張</dd></div>)}</dl>
            {group.review.length>0&&<ul aria-label="待核對餐號">{group.review.map(({id,state})=>
              <li key={id}>#{numberOf(id)} · {paymentStateNames[state]}</li>)}</ul>}
          </article>;
        })}
      </div>
    </>}
  </section>;
}

function formatDuration(ms) {
  const seconds=Math.ceil(ms/1000);
  const minutes=Math.floor(seconds/60);
  return minutes?minutes+" 分 "+seconds%60+" 秒":seconds+" 秒";
}

function DurationValue({stage}){
  return <dd>
    {stage.samples>0?<><strong>中位數 {formatDuration(stage.medianMs)}</strong>
      <span>第 90 百分位數 {formatDuration(stage.p90Ms)}</span></>:<span>目前無可用時間紀錄</span>}
    <small>可用紀錄 {stage.samples}／{stage.eligible} 張</small>
  </dd>;
}

function DurationSummary({timing}) {
  return <section className="sheet dailyTiming" aria-labelledby="daily-timing-title">
    <h2 id="daily-timing-title">製作與交餐耗時</h2>
    <p>製作從接單到備妥，交餐從備妥到交付。樣本數只計入兩端都有時間的餐單。</p>
    <div className="dailyTimingGrid">
      {[["pickup","自取"],["table","掃碼內用"]].map(([mode,name])=><article key={mode} aria-label={name+"耗時"}>
        <h3>{name}</h3>
        <dl>{[["preparation","製作"],["handoff","交餐等候"]].map(([key,label])=>
          <div key={key}><dt>{label}</dt><DurationValue stage={timing[mode][key]}/></div>)}</dl>
      </article>)}
    </div>
  </section>;
}

function ArrivalSummary({timing}){
  return <section className="sheet dailyTiming" aria-labelledby="daily-arrival-title">
    <h2 id="daily-arrival-title">自取到店後等候</h2>
    <p>按台灣到店日期統計。{timing.reported} 張回報到店，{timing.overall.eligible} 張已交餐。</p>
    <div className="dailyTimingGrid">
      {[["overall","全部到店等候"],["readyAtArrival","到店時已備妥"],["preparingAtArrival","到店時尚未備妥"]].map(([key,label])=>
        <article key={key} aria-label={label}><dl><div><dt>{label}</dt><DurationValue stage={timing[key]}/></div></dl></article>)}
    </div>
    {timing.unknownReadiness>0&&<p>有 {timing.unknownReadiness} 張缺少有效的備妥時間，等候時間計入全部到店等候。</p>}
  </section>;
}

function PickupPunctuality({date,report}){
  const {totals,windows}=report;
  const assessed=totals.onTime+totals.late+totals.overdue;
  const rate=assessed?new Intl.NumberFormat("zh-TW",{style:"percent",maximumFractionDigits:1}).format(totals.onTime/assessed):null;
  const fields=[["onTime","準時備妥"],["late","逾時備妥"],["overdue","逾時仍未備妥"]];
  return <section className="sheet dailyTiming" aria-labelledby="pickup-punctuality-title">
    <h2 id="pickup-punctuality-title">預約自取備妥準時率</h2>
    <p>按台灣取餐日期統計。時段結束前或在截止當刻備妥，都算準時。</p>
    {totals.bookings===0?<p>這一天沒有自取預約。</p>:<>
      <div className="dailyTimingGrid">
        <article aria-label="備妥準時率">
          <h3>{rate??"目前無可判定餐單"}</h3>
          <p>準時 {totals.onTime}／可判定 {assessed} 張</p>
          <dl>{fields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{totals[key]} 張</dd></div>)}</dl>
        </article>
        <article aria-label="未納入準時率">
          <h3>未納入準時率</h3>
          <dl>{[["waiting","尚未到截止時間"],["unknown","缺少有效備妥時間"],["awaitingPayment","不符出餐付款條件"],["cancelled","已取消"]]
            .map(([key,label])=><div key={key}><dt>{label}</dt><dd>{totals[key]} 張</dd></div>)}</dl>
        </article>
      </div>
      <div className="punctualityWindows">
        {windows.map(window=><article key={window.start} aria-label={pickupWindow(window.start)}>
          <h3>{pickupWindow(window.start)}</h3>
          <p>{fields.map(([key,label])=>label+" "+window[key]+" 張").join(" · ")}</p>
          {window.issues.length>0&&<ul>{window.issues.map(issue=><li key={issue.id}>
            <a className="textLink" href={"/kitchen?"+new URLSearchParams({booking:numberOf(issue.id),date,slot:String(window.start)})}>#{numberOf(issue.id)}</a>
            <span>{issue.status==="late"?"逾時備妥 "+formatDuration(issue.readyAt-window.end):"逾時仍未備妥"}</span>
          </li>)}</ul>}
        </article>)}
      </div>
    </>}
  </section>;
}

export default function DailyOperations() {
  const today=useBusinessToday();
  const [draft,setDraft]=useState(null),[query,setQuery]=useState(null),[view,setView]=useState(null);
  const date=draft??today;
  const queryDate=query?.date??today;
  const revision=query?.revision??0;
  useEffect(()=>{
    if(!queryDate)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/daily?date="+encodeURIComponent(queryDate)+"&timing=1&itemChannels=1&pickupPunctuality=1&paymentSummary=1",{
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
      headers:key?{Authorization:"Bearer "+key}:{},
    }).then(value=>{
      if(!controller.signal.aborted)setView({date:queryDate,revision,report:value});
    }).catch(failure=>{
      if(!controller.signal.aborted)setView({date:queryDate,revision,
        error:failure.name==="TimeoutError"?"讀取摘要逾時，請重新查詢。":failure.message});
    });
    return ()=>controller.abort();
  },[queryDate,revision]);
  const current=view?.date===queryDate&&view.revision===revision?view:null;
  const report=current?.report;

  function changeQuery(date) {
    setQuery(previous=>({date,revision:(previous?.revision??0)+1}));
  }
  function search(event) {
    event.preventDefault();
    setDraft(date);
    changeQuery(date);
  }
  function selectDate(event) {
    setDraft(event.target.value);
    changeQuery("");
  }
  return <><Header/><main className="shell section dailyOperations">
    <div className="actions dailyControl"><a className="textLink" href="/kitchen">返回店家接單台</a>
      <a className="textLink" href="/kitchen/cash-close">查看現金日結</a>
      <a className="textLink" href="/kitchen/refunds">查看示範退款</a></div>
    <h1>每日訂單摘要</h1>
    <p>按台灣日期查詢。餐單金額為已交餐單的原成交金額（含示範單），依成立日統計。</p>
    <form className="actions dailyDate dailyControl" onSubmit={search}>
      <label>餐單日期<input type="date" required value={date} onChange={selectDate}/></label>
      <button className="outline" disabled={!date}>查詢摘要</button>
    </form>
    {current?.error&&<p role="alert" className="error dailyControl">{current.error}</p>}
    {queryDate&&!current&&<p role="status" className="dailyControl">正在讀取摘要…</p>}
    {report&&<>
      <div className="actions dailyCapture">
        <p>{report.date} · 擷取時間（台灣） <time dateTime={new Date(report.capturedAt).toISOString()}>{captureTime.format(report.capturedAt)}</time></p>
        <button className="outline dailyControl" onClick={()=>window.print()}>列印交班摘要</button>
        <button className="outline dailyControl" onClick={()=>downloadJson("hey-table-daily-"+report.date+"-",report.capturedAt,report)}>下載摘要 JSON</button>
      </div>
      <div className="kGrid">
        <ChannelSummary name="自取" summary={report.channels.pickup}/>
        <ChannelSummary name="掃碼內用" summary={report.channels.table}/>
      </div>
      {report.paymentSummary&&<PaymentSummary summary={report.paymentSummary}/>}
      {report.timing&&<DurationSummary timing={report.timing}/>}
      {report.arrivalTiming&&<ArrivalSummary timing={report.arrivalTiming}/>}
      {report.pickupPunctuality&&<PickupPunctuality date={report.date} report={report.pickupPunctuality}/>}
      <section className="sheet dailyDishes">
        <div className="actions dailyDishesHeader">
          <h2>已交餐品項</h2>
          {report.items.length>0&&<button className="outline dailyControl" onClick={()=>downloadPortions(report)}>下載份數 CSV</button>}
        </div>
        {report.items.length?<table aria-label="已交餐份數">
          <thead><tr><th scope="col">餐點</th><th scope="col">自取</th><th scope="col">內用</th><th scope="col">合計</th></tr></thead>
          <tbody>{report.items.map(({id,name,pickupQty,tableQty,qty})=><tr key={id}>
            <th scope="row">{name}</th><td>{pickupQty}</td><td>{tableQty}</td><td>{qty}</td>
          </tr>)}</tbody>
        </table>:<p>這一天沒有已交餐品項。</p>}
      </section>
    </>}
  </main><Footer/></>;
}
