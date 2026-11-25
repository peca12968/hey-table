"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {downloadFile} from "../../../lib/download-file.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
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
  const csv = rows.map(row=>row.map(value=>{
    if(typeof value==="number")return String(value);
    const text=String(value);
    const escaped=/^\s*[=+@-]|^[\t\r\n]/.test(text)?"'"+text:text;
    return '"'+escaped.replaceAll('"','""')+'"';
  }).join(",")).join("\r\n")+"\r\n";
  downloadFile(new Blob(["\uFEFF",csv],{type:"text/csv;charset=utf-8"}),"hey-table-portions-"+report.date+"-"+capturedAt.replaceAll(":","-")+".csv");
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

function formatDuration(ms) {
  const seconds=Math.ceil(ms/1000);
  const minutes=Math.floor(seconds/60);
  return minutes?minutes+" 分 "+seconds%60+" 秒":seconds+" 秒";
}

function DurationSummary({timing}) {
  return <section className="sheet dailyTiming" aria-labelledby="daily-timing-title">
    <h2 id="daily-timing-title">製作與交餐耗時</h2>
    <p>製作從接單到備妥，交餐從備妥到交付。樣本數只計入兩端都有時間的餐單。</p>
    <div className="dailyTimingGrid">
      {[["pickup","自取"],["table","掃碼內用"]].map(([mode,name])=><article key={mode} aria-label={name+"耗時"}>
        <h3>{name}</h3>
        <dl>{[["preparation","製作"],["handoff","交餐等候"]].map(([key,label])=>{
          const stage=timing[mode][key];
          return <div key={key}><dt>{label}</dt><dd>
            {stage.samples>0?<><strong>中位數 {formatDuration(stage.medianMs)}</strong>
              <span>第 90 百分位數 {formatDuration(stage.p90Ms)}</span></>:<span>目前無可用時間紀錄</span>}
            <small>可用紀錄 {stage.samples}／{stage.eligible} 張</small>
          </dd></div>;
        })}</dl>
      </article>)}
    </div>
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
    request("/api/kitchen/daily?date="+encodeURIComponent(queryDate)+"&timing=1&itemChannels=1",{
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
    <p>按台灣日期查看當天成立的餐單。金額為已交餐單的原成交金額，包含示範單。</p>
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
      {report.timing&&<DurationSummary timing={report.timing}/>}
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
