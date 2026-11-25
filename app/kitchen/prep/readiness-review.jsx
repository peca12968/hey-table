"use client";
import {useMemo,useRef,useState} from "react";
import {numberOf} from "../../../lib/menu.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import {forecastPrepReadiness} from "../../../lib/prep-readiness.mjs";
import {matchesPrepOrderSource,prepOrderSource,prepOrdersFormat,prepReportFormat,readPrepReadinessReport} from "../../../lib/prep-readiness-report.mjs";

const jsonLimit=4*1024*1024;

async function readJson(file,label){
  if(file.size>jsonLimit)throw new Error(label+"超過 4 MB。");
  try{return JSON.parse(await file.text());}
  catch{throw new Error("無法讀取"+label+"。請選擇有效的 JSON 檔案。");}
}

export default function ReadinessReview({snapshot,orders,station,scope,clock}){
  const [fileState,setFileState]=useState(null);
  const [recipeFile,setRecipeFile]=useState(null);
  const [stockFile,setStockFile]=useState(null);
  const [includePreparing,setIncludePreparing]=useState(false);
  const operation=useRef(0);
  const source=useMemo(()=>{
    if(!snapshot)return null;
    try{return prepOrderSource({date:snapshot.date,capturedAt:snapshot.capturedAt,orders,station,scope});}
    catch{return null;}
  },[snapshot,orders,station,scope]);
  const report=fileState?.report;
  const matches=report&&source&&matchesPrepOrderSource(source,report.source);

  async function readFile(event){
    const input=event.currentTarget,file=input.files[0];
    input.value="";
    if(!file)return;
    const version=++operation.current;
    if(file.size>jsonLimit){
      setFileState({error:"報告超過 4 MB。可依分站下載較小的試算資料。"});
      return;
    }
    setFileState({loading:"正在讀取報告…"});
    try{
      const report=readPrepReadinessReport(JSON.parse(await file.text()));
      if(version===operation.current)setFileState({report});
    }catch{
      if(version===operation.current)setFileState({error:"無法讀取備料試算報告。請選擇 Prep Sheet 產生的 JSON。"});
    }
  }
  async function calculate(){
    const version=++operation.current;
    setFileState({loading:"正在試算備料…"});
    try{
      const [recipes,stock]=await Promise.all([readJson(recipeFile,"食譜"),readJson(stockFile,"庫存")]);
      if(version!==operation.current)return;
      const result=forecastPrepReadiness(source.orders,recipes,stock,includePreparing);
      const exchange={format:prepReportFormat,source,orders:result.orders};
      setFileState({report:readPrepReadinessReport(exchange),exchange});
    }catch(error){
      if(version===operation.current)setFileState({error:error.message});
    }
  }
  function clear(){
    ++operation.current;
    setFileState(null);
  }
  function changeInput(setValue,value){
    setValue(value);
    if(fileState?.exchange||fileState?.error)setFileState(null);
  }

  if(!source)return snapshot?<p role="status">目前擷取缺少試算資料，請重新擷取。</p>:null;
  const ready=matches?report.orders.filter(order=>order.status==="ready").length:0;
  return <section className="sheet prepControl prepReadiness" aria-labelledby="prep-readiness-title">
    <h2 id="prep-readiness-title">備料試算報告</h2>
    <p>食譜、庫存與報告均在此瀏覽器內讀取。</p>
    <fieldset className="prepReadinessFiles" disabled={Boolean(fileState?.loading)}>
      <legend>依目前餐單試算</legend>
      <div className="actions prepReadinessActions">
        <label>食譜 JSON<input type="file" accept=".json,application/json"
          onChange={event=>changeInput(setRecipeFile,event.currentTarget.files[0]??null)}/></label>
        <label>庫存 JSON<input type="file" accept=".json,application/json"
          onChange={event=>changeInput(setStockFile,event.currentTarget.files[0]??null)}/></label>
      </div>
      <div className="actions">
        <label className="prepReadinessPreparing"><input type="checkbox" checked={includePreparing}
          onChange={event=>changeInput(setIncludePreparing,event.currentTarget.checked)}/>納入製作中餐單</label>
        <button className="primary" type="button" disabled={!recipeFile||!stockFile} onClick={calculate}>開始試算</button>
      </div>
    </fieldset>
    <div className="actions prepReadinessActions">
      <button className="outline" type="button" onClick={()=>
        downloadJson("hey-table-prep-readiness-input-",source.capturedAt,{format:prepOrdersFormat,...source})}>
        下載備料試算資料
      </button>
      <label>備料試算報告 JSON<input type="file" accept=".json,application/json" onChange={readFile}/></label>
      {fileState&&<button className="outline" type="button" onClick={clear}>清除報告</button>}
    </div>
    {fileState?.loading&&<p role="status">{fileState.loading}</p>}
    {fileState?.error&&<p className="error" role="alert">{fileState.error}</p>}
    {report&&!matches&&<p className="error" role="alert">報告與目前的備料日期、分站、範圍或餐單不同。請切回原範圍，或用目前餐單重新試算。</p>}
    {matches&&<section className="prepReadinessResult" aria-label="備料試算結果">
      <p role="status">可先做 {ready} 張 · 缺料暫緩 {report.orders.length-ready} 張 · 試算 {report.orders.length}／{source.orders.length} 張</p>
      <p>報告使用的餐單擷取時間 <time dateTime={new Date(report.source.capturedAt).toISOString()}>
        {clock.format(report.source.capturedAt)}</time></p>
      {fileState.exchange&&<button className="outline" type="button" onClick={()=>
        downloadJson("hey-table-prep-readiness-report-",report.source.capturedAt,fileState.exchange)}>
        下載備料試算報告
      </button>}
      {report.orders.length>0&&<ul>{report.orders.map(order=><li key={order.order_id}>
        <h3>餐單 #{numberOf(order.order_id)} · {order.status==="ready"?"可先做":"缺料暫緩"}</h3>
        {order.missing.length>0&&<p>缺 {order.missing.map(line=>line.name+" "+line.quantity+" "+line.unit).join("、")}</p>}
        {order.prep.length>0&&<p>備料順序 {order.prep.map(line=>line.name+" "+line.batches+" 批").join(" → ")}</p>}
      </li>)}</ul>}
    </section>}
  </section>;
}
