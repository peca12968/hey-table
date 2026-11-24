"use client";

import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import {numberOf} from "../../../lib/menu.mjs";
import "./cash-close.css";

const dayTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
const time=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
const currency=new Intl.NumberFormat("zh-TW");
const money=value=>currency.format(BigInt(value));
const blank={opening:"",adjustments:"",counted:""};

function amount(value,signed=false){
  const pattern=signed?/^-?\d+$/:/^\d+$/;
  return pattern.test(value)?BigInt(value):null;
}

function CashCount({count,setCount,report}){
  const opening=amount(count.opening),counted=amount(count.counted),adjustments=count.adjustments===""?0n:amount(count.adjustments,true);
  const invalid=(count.opening!==""&&opening===null)||(count.counted!==""&&counted===null)||adjustments===null;
  const expected=opening!==null&&adjustments!==null?opening+BigInt(report.totals.net)+adjustments:null;
  const difference=expected!==null&&counted!==null?counted-expected:null;
  const reconciliation=difference===null?null:{opening:String(opening),adjustments:String(adjustments),
    expected:String(expected),counted:String(counted),difference:String(difference)};

  return <section className="sheet cashCount" aria-labelledby="cash-count-heading">
    <h2 id="cash-count-heading">錢櫃盤點</h2>
    <p>預期收班現金包含開班現金、已登記淨收和其他現金淨額。提取或退款可填負數。填齊金額後，下載會附上盤點差額。</p>
    <div className="cashCountFields">
      {[["opening","開班現金"],["adjustments","其他現金淨額（選填）"],["counted","實點收班現金"]].map(([field,label])=>
        <label key={field}>{label}<input type="text" inputMode={field==="adjustments"?"text":"numeric"}
          value={count[field]} onChange={event=>setCount({...count,[field]:event.target.value})}/></label>)}
    </div>
    {invalid&&<p className="error" role="alert">請輸入整數。開班與實點金額須為零或正數。</p>}
    <div className="cashCountResult" role="status">
      {expected!==null&&<p>預期收班現金 NT$ {money(expected)}</p>}
      {difference!==null&&<p>{difference===0n?"盤點相符":`盤點${difference<0n?"短少":"多出"} NT$ ${money(difference<0n?-difference:difference)}`}</p>}
    </div>
    <button className="outline" onClick={()=>downloadJson("hey-table-cash-close-"+report.date+"-",report.capturedAt,
      reconciliation?{...report,reconciliation}:report)}>下載現金日結 JSON</button>
  </section>;
}

export default function CashClose(){
  const today=useBusinessToday();
  const [day,setDay]=useState(null),[revision,setRevision]=useState(0),[view,setView]=useState(null);
  const [savedCount,setSavedCount]=useState(null);
  const date=day??today;
  const count=savedCount?.date===date?savedCount.value:blank;
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController();
    const key=sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/cash-close?date="+encodeURIComponent(date),{
      headers:key?{Authorization:"Bearer "+key}:{},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(report=>{
      if(!controller.signal.aborted)setView({date,revision,report});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({date,revision,error:error.name==="TimeoutError"?"讀取現金日結逾時，請重新擷取。":error.message,
        denied:error.status===403});
    });
    return ()=>controller.abort();
  },[date,revision]);
  const current=view?.date===date&&view.revision===revision?view:null;
  const report=current?.report;

  return <><Header/><main className="shell section cashClose">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>現金日結</h1>
    <p>依台灣時間的收款登記日期彙總，補登會列入實際登記日。</p>
    <div className="actions cashCloseControls">
      <label>收款登記日期<input type="date" value={date} disabled={!today} onChange={event=>{
        setDay(event.target.value);setSavedCount(null);
      }}/></label>
      <button className="outline" disabled={!date||!current} onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
    </div>
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="primary" href="/signin-with-chatgpt?return_to=%2Fkitchen%2Fcash-close" target="_top">使用 ChatGPT 登入</a>}
    {date&&!current&&<p role="status">正在讀取現金日結…</p>}
    {report&&<>
      <section className="sheet cashCloseSummary" aria-label="現金日結摘要">
        <p><strong>{report.date}</strong> · 擷取時間 <time dateTime={new Date(report.capturedAt).toISOString()}>{dayTime.format(report.capturedAt)}</time></p>
        <dl>{[["登記筆數",report.totals.receipts+" 筆"],["實收","NT$ "+money(report.totals.tendered)],
          ["找零","NT$ "+money(report.totals.change)],["淨收","NT$ "+money(report.totals.net)]].map(([label,value])=>
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>
      <CashCount count={count} setCount={value=>setSavedCount({date,value})} report={report}/>
      <section className="sheet cashCloseReceipts">
        <h2>收款明細</h2>
        {report.receipts.length===0?<p>這天沒有已登記的現金收款。</p>:<table aria-label="現金收款明細">
          <thead><tr><th scope="col">餐單</th><th scope="col">實收</th><th scope="col">找零</th><th scope="col">淨收</th></tr></thead>
          <tbody>{report.receipts.map(row=><tr key={row.orderId}>
            <th scope="row">#{numberOf(row.orderId)} <small>{row.mode==="table"?"掃碼內用":"自取"} · <time dateTime={new Date(row.recordedAt).toISOString()}>{time.format(row.recordedAt)}</time></small></th>
            <td>{money(row.tendered)}</td><td>{money(row.change)}</td><td>{money(row.amount)}</td>
          </tr>)}</tbody>
        </table>}
      </section>
    </>}
  </main><Footer/></>;
}
