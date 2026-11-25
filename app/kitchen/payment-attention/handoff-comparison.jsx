"use client";

import {useRef,useState} from "react";
import {comparePaymentHandoffSummaries,paymentSummaryFileLimit,readPaymentHandoffSummary} from "../../../lib/payment-handoff-compare.mjs";
import {methods} from "../../../lib/payments.mjs";

const metrics=[["orders","待核對"],["amount","原餐單金額"],["pending","付款確認中"],
  ["authorized","已授權待請款"],["overdue","已到保留時間"]];
const comparisonErrors={
  filters:"兩份摘要的付款工具、付款狀態或金流環境篩選不同。請使用相同篩選條件。",
  time:"匯入摘要的擷取時間晚於目前畫面。請重新擷取後再比較。"
};

function metricValue(key,value,signed=false){
  const amount=BigInt(value), magnitude=amount<0n?-amount:amount;
  const sign=amount<0n?"−":signed&&amount>0n?"+":"";
  return sign+magnitude.toLocaleString("zh-TW")+(key==="amount"?" 元":" 筆");
}

function DifferenceTable({label,before,after,delta}){
  return <table aria-label={label}>
    <thead><tr><th scope="col">項目</th><th scope="col">上次</th><th scope="col">本次</th><th scope="col">差異</th></tr></thead>
    <tbody>{metrics.map(([key,title])=><tr key={key}>
      <th scope="row">{title}</th>
      <td>{metricValue(key,before[key])}</td><td>{metricValue(key,after[key])}</td><td>{metricValue(key,delta[key],true)}</td>
    </tr>)}</tbody>
  </table>;
}

export default function HandoffComparison({summary,timeLabel,environmentName}){
  const [open,setOpen]=useState(false),[fileState,setFileState]=useState(null);
  const readVersion=useRef(0);

  async function readFile(event){
    const input=event.currentTarget,file=input.files[0];
    input.value="";
    if(!file)return;
    const version=++readVersion.current;
    if(file.size>paymentSummaryFileLimit){
      setFileState({error:"摘要檔案超過 64 KB。請選擇從待核對付款頁下載的 JSON。"});
      return;
    }
    setFileState({loading:true});
    try{
      const baseline=readPaymentHandoffSummary(JSON.parse(await file.text()));
      if(readVersion.current===version)setFileState({baseline});
    }catch{
      if(readVersion.current===version)setFileState({error:"無法讀取摘要。請選擇從待核對付款頁下載的有效 JSON。"});
    }
  }

  function clearFile(){
    ++readVersion.current;
    setFileState(null);
  }

  if(!summary)return null;
  const comparison=fileState?.baseline&&comparePaymentHandoffSummaries(fileState.baseline,summary);
  const error=fileState?.error??comparisonErrors[comparison?.kind];
  return <details className="sheet paymentHandoffComparison" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>比較付款交班摘要</summary>
    <p id="payment-handoff-file-help">選擇上一班下載的摘要。檔案只在此頁面讀取，兩次擷取須使用相同篩選條件。</p>
    <div className="paymentHandoffFiles">
      <label>上一班摘要 JSON<input type="file" accept=".json,application/json" aria-describedby="payment-handoff-file-help" onChange={readFile}/></label>
      {fileState&&<button type="button" className="outline" onClick={clearFile}>清除已匯入摘要</button>}
    </div>
    {fileState?.loading&&<p role="status">正在讀取上一班摘要…</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {comparison?.kind==="compared"&&<section aria-label="付款交班比較結果">
      <p>上次擷取 {timeLabel(comparison.earlierAt)}<br/>本次擷取 {timeLabel(comparison.currentAt)}</p>
      <h3>整體變化</h3>
      <DifferenceTable label="整體變化" {...comparison.totals}/>
      {comparison.groups.length===0&&<p>各付款分組皆無變化。</p>}
      {comparison.groups.map(({method,environment,...group})=>{
        const label=(methods[method]??"付款方式未記錄")+" · "+(environmentName[environment]??"環境未記錄");
        return <section key={method+":"+environment}>
          <h3>{label}</h3>
          <DifferenceTable label={label} {...group}/>
        </section>;
      })}
    </section>}
  </details>;
}
