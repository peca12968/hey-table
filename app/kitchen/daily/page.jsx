"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {businessDate} from "../../../lib/business-day.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import "./daily.css";

const captureTime = new Intl.DateTimeFormat("zh-TW", {
  timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"medium",
});
const statusFields = [
  ["orders","全部餐單"],["pending","待接單"],["preparing","製作中"],
  ["ready","待交餐"],["completed","已交餐"],["cancelled","已取消"],
];

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
  const [date,setDate]=useState(""),[query,setQuery]=useState(null);
  const [report,setReport]=useState(null),[error,setError]=useState("");
  useEffect(()=>{
    const today=businessDate(Date.now());
    setDate(today);
    setQuery({date:today});
  },[]);
  useEffect(()=>{
    if(!query)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/daily?date="+encodeURIComponent(query.date)+"&timing=1",{
      signal:controller.signal,headers:key?{Authorization:"Bearer "+key}:{},
    }).then(value=>{
      if(!controller.signal.aborted)setReport(value);
    }).catch(failure=>{
      if(!controller.signal.aborted)setError(failure.message);
    });
    return ()=>controller.abort();
  },[query]);
  function search(event) {
    event.preventDefault();
    setError("");setReport(null);setQuery({date});
  }
  function selectDate(event) {
    setDate(event.target.value);setError("");setReport(null);setQuery(null);
  }
  return <><Header/><main className="shell section dailyOperations">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>每日訂單摘要</h1>
    <p>按台灣日期查看當天成立的餐單。金額為已交餐單的原成交金額，包含示範單。</p>
    <form className="actions dailyDate" onSubmit={search}>
      <label>餐單日期<input type="date" required value={date} onChange={selectDate}/></label>
      <button className="outline" disabled={!date}>查詢摘要</button>
    </form>
    {error&&<p role="alert" className="error">{error}</p>}
    {query&&!report&&!error&&<p role="status">正在讀取摘要…</p>}
    {report&&<>
      <div className="actions dailyCapture">
        <p>{report.date} · 擷取時間 <time dateTime={new Date(report.capturedAt).toISOString()}>{captureTime.format(report.capturedAt)}</time></p>
        <button className="outline" onClick={()=>downloadJson("hey-table-daily-"+report.date+"-",report.capturedAt,report)}>下載摘要 JSON</button>
      </div>
      <div className="kGrid">
        <ChannelSummary name="自取" summary={report.channels.pickup}/>
        <ChannelSummary name="掃碼內用" summary={report.channels.table}/>
      </div>
      {report.timing&&<DurationSummary timing={report.timing}/>}
      <section className="sheet dailyDishes">
        <h2>已交餐品項</h2>
        {report.items.length?<table aria-label="已交餐份數"><thead><tr><th scope="col">餐點</th><th scope="col">份數</th></tr></thead>
          <tbody>{report.items.map(({id,name,qty})=><tr key={id}><th scope="row">{name}</th><td>{qty}</td></tr>)}</tbody>
        </table>:<p>這一天沒有已交餐品項。</p>}
      </section>
    </>}
  </main><Footer/></>;
}
