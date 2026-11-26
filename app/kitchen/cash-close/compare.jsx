"use client";

import {useEffect,useRef,useState} from "react";
import {request} from "../../shared";
import {numberOf} from "../../../lib/menu.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";

const labels={added:"新增收款",corrected:"更正收款",missing:"新版缺少收款",changed:"收款資料異動"};
const ledgerFields={receipts:"登記筆數",tendered:"實收",change:"找零",net:"淨收"};
const countFields={opening:"開班現金",adjustments:"其他現金淨額",counted:"實點收班現金",expected:"預期收班現金",difference:"盤點差額"};
const receiptFields={tendered:"實收",change:"找零",amount:"淨收"};
const currency=new Intl.NumberFormat("zh-TW");
const amount=value=>currency.format(BigInt(value));
const signed=value=>BigInt(value)>0n?"+"+amount(value):amount(value);
const clock=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});

function DifferenceTable({title,values,fields}){
  return <table aria-label={title}>
    <thead><tr><th scope="col">項目</th><th scope="col">舊版</th><th scope="col">新版</th><th scope="col">差異</th></tr></thead>
    <tbody>{Object.entries(fields).map(([key,label])=>{
      const {before,after,delta}=values[key],unit=key==="receipts"?" 筆":" 元";
      return <tr key={key}><th scope="row">{label}</th><td>{amount(before)+unit}</td><td>{amount(after)+unit}</td>
        <td>{signed(delta)+unit}</td></tr>;
    })}</tbody>
  </table>;
}

function ChangedReceipts({receipts}){
  if(!receipts.length)return <p>兩版的收款明細相同。</p>;
  return <ul className="cashCloseChanged" aria-label="有異動的收款">
    {receipts.map(row=><li key={row.orderId}>
      <strong>餐單 #{numberOf(row.orderId)} · {labels[row.kind]}</strong>
      {row.kind==="corrected"&&<p>{row.before.correctionRevision?"更正第 "+row.before.correctionRevision+" 版":"原登記"}
        {" → 更正第 "+row.after.correctionRevision+" 版"}</p>}
      <dl>{Object.entries(receiptFields).map(([key,label])=><div key={key}><dt>{label}</dt>
        <dd>{row.before?amount(row.before[key])+" 元":"未登記"} → {row.after?amount(row.after[key])+" 元":"未登記"}</dd>
      </div>)}</dl>
    </li>)}
  </ul>;
}

export default function CashCloseCompare({date,versions}){
  const [from,setFrom]=useState(String(versions[1].revision)),[to,setTo]=useState(String(versions[0].revision));
  const [view,setView]=useState(null);
  const active=useRef(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  const ordered=Number(from)<Number(to);
  const result=view?.result;

  async function compare(event){
    event.preventDefault();
    if(!ordered||active.current)return;
    const controller=new AbortController();
    active.current=controller;
    setView({loading:true});
    const key=sessionStorage.getItem("he-ri-staff");
    try{
      const reply=await request("/api/kitchen/cash-close-compare?"+new URLSearchParams({date,from,to}),{
        headers:key?{Authorization:"Bearer "+key}:{},
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
      });
      if(!controller.signal.aborted)setView({result:reply});
    }catch(failure){
      if(!controller.signal.aborted)setView({error:failure.name==="TimeoutError"?"讀取盤點比較逾時，請再試一次。":failure.message});
    }finally{if(active.current===controller)active.current=null;}
  }

  return <section className="sheet cashCloseCompare" aria-labelledby="cash-close-compare-title">
    <h2 id="cash-close-compare-title">比較盤點版本</h2>
    <form className="actions cashCloseCompareControls" onSubmit={compare}>
      <label>舊版<select value={from} disabled={view?.loading} onChange={event=>{setFrom(event.target.value);setView(null);}}>
        {versions.map(version=><option key={version.revision} value={version.revision}>第 {version.revision} 版</option>)}
      </select></label>
      <label>新版<select value={to} disabled={view?.loading} onChange={event=>{setTo(event.target.value);setView(null);}}>
        {versions.map(version=><option key={version.revision} value={version.revision}>第 {version.revision} 版</option>)}
      </select></label>
      <button className="outline" disabled={!ordered||view?.loading}>比較版本</button>
    </form>
    {!ordered&&<p className="hint">舊版版號須早於新版。</p>}
    {view?.loading&&<p role="status">正在讀取兩份已保存的盤點…</p>}
    {view?.error&&<p role="alert" className="error">{view.error}</p>}
    {result&&<>
      <p>第 {result.from.revision} 版保存於 <time dateTime={new Date(result.from.savedAt).toISOString()}>{clock.format(result.from.savedAt)}</time>
        <br/>第 {result.to.revision} 版保存於 <time dateTime={new Date(result.to.savedAt).toISOString()}>{clock.format(result.to.savedAt)}</time></p>
      <h3>收款合計</h3>
      <DifferenceTable title="收款合計變化" fields={ledgerFields} values={result.totals}/>
      <h3>錢櫃盤點</h3>
      <DifferenceTable title="錢櫃盤點變化" fields={countFields} values={result.reconciliation}/>
      <h3>變動餐單</h3>
      <ChangedReceipts receipts={result.receipts}/>
      <button className="outline" onClick={()=>downloadJson("hey-table-cash-close-compare-"+date+"-v"+
        result.from.revision+"-v"+result.to.revision+"-",result.to.savedAt,result)}>下載版本比較 JSON</button>
    </>}
  </section>;
}
