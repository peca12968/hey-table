"use client";

import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {useBusinessToday} from "../../use-business-today.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import {numberOf} from "../../../lib/menu.mjs";
import {cashAmount,reconcileCash} from "../../../lib/cash-reconciliation.mjs";
import "./cash-close.css";

const dayTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
const time=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
const currency=new Intl.NumberFormat("zh-TW");
const money=value=>currency.format(BigInt(value));
const blank={opening:"",adjustments:"",counted:""};
const versionsEndpoint="/api/kitchen/cash-close-versions";
const draftKey=date=>"he-ri-cash-close:"+date;

function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}
function pendingFor(date){
  try{return JSON.parse(sessionStorage.getItem(draftKey(date)));}
  catch{return null;}
}
function rememberPending(date,payload){
  try{
    if(payload)sessionStorage.setItem(draftKey(date),JSON.stringify(payload));
    else sessionStorage.removeItem(draftKey(date));
  }catch{/* Kept in memory while this page remains open. */}
}

function CashCount({count,setCount,report,canSave,saving,pending,onSave}){
  const opening=cashAmount(count.opening),counted=cashAmount(count.counted);
  const adjustments=count.adjustments===""?0n:cashAmount(count.adjustments,true);
  const invalid=(count.opening!==""&&opening===null)||(count.counted!==""&&counted===null)||adjustments===null;
  const expected=opening!==null&&adjustments!==null?opening+BigInt(report.totals.net)+adjustments:null;
  const difference=expected!==null&&counted!==null?counted-expected:null;
  const reconciliation=difference===null?null:reconcileCash(report.totals.net,opening,adjustments,counted);

  return <section className="sheet cashCount" aria-labelledby="cash-count-heading">
    <h2 id="cash-count-heading">錢櫃盤點</h2>
    <p>預期收班現金包含開班現金、已登記淨收和其他現金淨額。提取或退款可填負數。填齊金額後，下載會附上盤點差額。</p>
    <div className="cashCountFields">
      {[["opening","開班現金"],["adjustments","其他現金淨額（選填）"],["counted","實點收班現金"]].map(([field,label])=>
        <label key={field}>{label}<input type="text" inputMode={field==="adjustments"?"text":"numeric"}
          value={count[field]} disabled={saving||Boolean(pending)} onChange={event=>setCount({...count,[field]:event.target.value})}/></label>)}
    </div>
    {invalid&&<p className="error" role="alert">請輸入整數。開班與實點金額須為零或正數。</p>}
    <div className="cashCountResult" role="status">
      {expected!==null&&<p>預期收班現金 NT$ {money(expected)}</p>}
      {difference!==null&&<p>{difference===0n?"盤點相符":`盤點${difference<0n?"短少":"多出"} NT$ ${money(difference<0n?-difference:difference)}`}</p>}
    </div>
    <div className="actions cashCountActions">
      {canSave&&<button className="primary" disabled={saving||(!pending&&!reconciliation)} onClick={()=>onSave(reconciliation)}>
        {saving?"正在保存…":pending?"重試保存盤點":"保存盤點版本"}
      </button>}
      <button className="outline" onClick={()=>downloadJson("hey-table-cash-close-"+report.date+"-",report.capturedAt,
        reconciliation?{...report,reconciliation}:report)}>下載現金日結 JSON</button>
    </div>
  </section>;
}

function CashCloseHistory({date,versions}){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  async function download(revision){
    setBusy(true);setError("");
    try{
      const saved=await request(versionsEndpoint+"?date="+encodeURIComponent(date)+"&revision="+revision,
        {headers:staffHeaders(),signal:AbortSignal.timeout(10_000)});
      downloadJson("hey-table-cash-close-"+date+"-v"+revision+"-",saved.savedAt,saved);
    }catch(failure){setError(failure.message);}
    finally{setBusy(false);}
  }
  return <section className="sheet cashCloseVersions" aria-label="已保存的盤點版本">
    <h2>已保存的盤點版本</h2>
    <ul>{versions.map(version=><li key={version.revision}>
      <div><strong>第 {version.revision} 版</strong> · {version.receipts} 筆收款
        <p>保存時間 <time dateTime={new Date(version.savedAt).toISOString()}>{dayTime.format(version.savedAt)}</time></p>
        <p>預期 NT$ {money(version.reconciliation.expected)} · 實點 NT$ {money(version.reconciliation.counted)} · 差額 NT$ {money(version.reconciliation.difference)}</p>
      </div>
      <button className="outline" disabled={busy} onClick={()=>download(version.revision)}>下載第 {version.revision} 版</button>
    </li>)}</ul>
    {error&&<p className="error" role="alert">{error}</p>}
  </section>;
}

export default function CashClose(){
  const today=useBusinessToday();
  const [day,setDay]=useState(null),[revision,setRevision]=useState(0),[view,setView]=useState(null);
  const [savedCount,setSavedCount]=useState(null);
  const [pending,setPending]=useState(null),[saving,setSaving]=useState(false);
  const [notice,setNotice]=useState(""),[saveError,setSaveError]=useState("");
  const date=day??today;
  const operation=pending?.date===date?pending:null;
  const count=operation??(savedCount?.date===date?savedCount.value:blank);
  useEffect(()=>{
    if(!date)return;
    const controller=new AbortController();
    const query="?date="+encodeURIComponent(date),options={headers:staffHeaders(),
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])};
    Promise.all([request("/api/kitchen/cash-close"+query,options),request(versionsEndpoint+query,options)])
    .then(([report,history])=>{
      if(!controller.signal.aborted){
        setView({date,revision,report,versions:history.versions});
        const stored=pendingFor(date);
        setPending(current=>current?.date===date?current:stored);
      }
    }).catch(error=>{
      if(!controller.signal.aborted)setView({date,revision,error:error.name==="TimeoutError"?"讀取現金日結逾時，請重新擷取。":error.message,
        denied:error.status===403});
    });
    return ()=>controller.abort();
  },[date,revision]);
  const current=view?.date===date&&view.revision===revision?view:null;
  const report=current?.report;

  async function save(reconciliation){
    if(saving||!report||(!operation&&!reconciliation))return;
    const payload=operation??{date,revision:current.versions[0]?.revision??0,operationId:crypto.randomUUID(),
      capturedAt:report.capturedAt,receiptCount:report.totals.receipts,
      opening:reconciliation.opening,adjustments:reconciliation.adjustments,counted:reconciliation.counted};
    rememberPending(date,payload);
    setSavedCount({date,value:{opening:payload.opening,adjustments:payload.adjustments,counted:payload.counted}});
    setSaving(true);setSaveError("");setNotice("");setPending(payload);
    try{
      const saved=await request(versionsEndpoint,{method:"POST",headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(15_000)});
      rememberPending(date,null);
      setPending(null);setNotice("已保存第 "+saved.revision+" 版盤點。");setRevision(value=>value+1);
    }catch(failure){
      if([400,403,404,409].includes(failure.status)){
        rememberPending(date,null);
        setPending(null);setSaveError(failure.message);
        if(failure.status===409)setRevision(value=>value+1);
      }else setSaveError("尚未收到保存結果。可用同一筆資料重試。");
    }finally{setSaving(false);}
  }

  return <><Header/><main className="shell section cashClose">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>現金日結</h1>
    <p>依台灣時間的收款登記日期彙總，補登會列入實際登記日。</p>
    <div className="actions cashCloseControls">
      <label>收款登記日期<input type="date" value={date} disabled={!today||saving} onChange={event=>{
        setDay(event.target.value);setSavedCount(null);setNotice("");setSaveError("");
      }}/></label>
      <button className="outline" disabled={!date||!current||saving} onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
    </div>
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="primary" href="/signin-with-chatgpt?return_to=%2Fkitchen%2Fcash-close" target="_top">使用 ChatGPT 登入</a>}
    {date&&!current&&<p role="status">正在讀取現金日結…</p>}
    {notice&&<p role="status">{notice}</p>}
    {saveError&&<p className="error" role="alert">{saveError}</p>}
    {report&&<>
      <section className="sheet cashCloseSummary" aria-label="現金日結摘要">
        <p><strong>{report.date}</strong> · 擷取時間 <time dateTime={new Date(report.capturedAt).toISOString()}>{dayTime.format(report.capturedAt)}</time></p>
        <dl>{[["登記筆數",report.totals.receipts+" 筆"],["實收","NT$ "+money(report.totals.tendered)],
          ["找零","NT$ "+money(report.totals.change)],["淨收","NT$ "+money(report.totals.net)]].map(([label,value])=>
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>
      <CashCount count={count} setCount={value=>setSavedCount({date,value})} report={report}
        canSave={date<=today} saving={saving} pending={operation} onSave={save}/>
      {current.versions.length>0&&<CashCloseHistory key={date} date={date} versions={current.versions}/>}
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
