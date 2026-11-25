"use client";

import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {labels,numberOf} from "../../../lib/menu.mjs";
import {methods} from "../../../lib/payments.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import "../daily/daily.css";

const taipeiTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",timeStyle:"medium",hourCycle:"h23"});
const taipeiCapture=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
const amount=value=>"NT$ "+value.toLocaleString("zh-TW");

export default function Refunds(){
  const today=useBusinessToday();
  const [day,setDay]=useState(null),[revision,setRevision]=useState(0),[view,setView]=useState(null);
  const date=day??today;
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/demo-refunds?date="+encodeURIComponent(date),{
      headers:key?{Authorization:"Bearer "+key}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(report=>{
      if(!controller.signal.aborted)setView({date,revision,report});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({date,revision,denied:error.status===403,
        error:error.name==="TimeoutError"?"讀取退款紀錄逾時，請重新查詢。":error.message});
    });
    return ()=>controller.abort();
  },[date,revision]);
  const current=view?.date===date&&view.revision===revision?view:null;
  const report=current?.report;

  return <><Header/><main className="shell section dailyOperations">
    <a className="textLink dailyControl" href="/kitchen">返回店家接單台</a>
    <h1>示範退款交班紀錄</h1>
    <p>按台灣退款日期列出有時間紀錄的示範退款。</p>
    <div className="actions dailyDate dailyControl">
      <label>退款日期<input type="date" value={date} onChange={event=>{
        setDay(event.target.value);setRevision(value=>value+1);
      }}/></label>
      <button className="outline" disabled={!date||!current} onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
    </div>
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="outline dailyControl" href="/signin-with-chatgpt?return_to=%2Fkitchen%2Frefunds" target="_top">使用 ChatGPT 登入</a>}
    {date&&!current&&<p role="status">正在讀取退款紀錄…</p>}
    {report&&<>
      <div className="actions dailyCapture">
        <p>{report.date} · 擷取時間（台灣） <time dateTime={new Date(report.capturedAt).toISOString()}>{taipeiCapture.format(report.capturedAt)}</time></p>
        <button className="outline dailyControl" onClick={()=>window.print()}>列印退款紀錄</button>
        <button className="outline dailyControl" onClick={()=>downloadJson("hey-table-demo-refunds-"+report.date+"-",report.capturedAt,report)}>下載退款 JSON</button>
      </div>
      <section className="sheet dailyDishes" aria-label="退款明細">
        <h2>{report.totals.count} 筆退款 · {amount(report.totals.amount)}</h2>
        {report.refunds.length>0?<>
          <p>退款前已交餐 {report.totals.completed} 筆</p>
          <table aria-label="示範退款明細">
            <thead><tr><th scope="col">餐單</th><th scope="col">退款前</th><th scope="col">時間</th><th scope="col">金額</th></tr></thead>
            <tbody>{report.refunds.map(refund=><tr key={refund.orderId}>
              <th scope="row">#{numberOf(refund.orderId)}<br/><small>{methods[refund.paymentMethod]} · {refund.mode==="table"?"內用":"自取"}</small></th>
              <td>{refund.previousStatus==="completed"?"已交餐":labels[refund.previousStatus]}</td>
              <td><time dateTime={new Date(refund.refundedAt).toISOString()}>{taipeiTime.format(refund.refundedAt)}</time></td>
              <td>{amount(refund.amount)}</td>
            </tr>)}</tbody>
          </table>
        </>:<p>這一天沒有可查詢的示範退款。</p>}
      </section>
    </>}
  </main><Footer/></>;
}
