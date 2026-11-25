import {useEffect,useRef,useState} from "react";
import {downloadJson} from "../../../lib/download-json.mjs";
import PantryWorker from "./purchase-worker.mjs?worker";

const money=value=>"NT$"+value.toLocaleString("zh-TW");
const workerUnavailable="無法啟動瀏覽器比價，請下載採購資料給 Pantry Freight 命令列試算。";

function QuoteResult({report,names,capturedAt}){
  if(report.status==="infeasible"){
    const limit=report.pack_limit;
    return <section aria-label="供應商比價結果">
      <p role="status">依目前供應商目錄無法補足缺口。</p>
      {limit?<p>{names.get(limit.component)} 需 {limit.required} {limit.unit}，允許購入上限 {limit.max_purchase} {limit.unit}。</p>:
        <ul>{report.shortages.map(line=><li key={line.component}>
          {names.get(line.component)} · 缺 {line.uncovered} {line.unit} · 供應商最多提供 {line.offered} {line.unit}
        </li>)}</ul>}
    </section>;
  }
  return <section aria-label="供應商比價結果">
    <p role="status">總價 {money(report.total_twd)} · 運費 {money(report.shipping_twd)} · 共 {report.packs} 包</p>
    <ul>{report.orders.map(order=><li key={order.supplier}>
      <strong>{order.supplier} · 貨款 {money(order.subtotal_twd)} · 運費 {money(order.shipping_twd)}</strong>
      <ul>{order.lines.map(line=><li key={line.sku}>
        {names.get(line.component)}（{line.sku}）· {line.packs} 包 × {line.pack} {line.unit} · {money(line.cost_twd)}
      </li>)}</ul>
    </li>)}</ul>
    <button className="outline" type="button" onClick={()=>downloadJson("hey-table-purchase-report-",capturedAt,report)}>
      下載採購報告
    </button>
  </section>;
}

export default function PurchaseQuote({plan,capturedAt}){
  const [file,setFile]=useState(null);
  const [quote,setQuote]=useState(null);
  const active=useRef(null);
  useEffect(()=>()=>{
    active.current?.worker?.terminate();
    active.current=null;
  },[]);

  function stop(){
    active.current?.worker?.terminate();
    active.current=null;
  }

  async function compare(){
    const job={};
    active.current=job;
    setQuote({loading:true});
    function finish(result){
      if(active.current!==job)return;
      stop();
      setQuote(result);
    }
    try{
      if(file.size>4*1024*1024)throw new Error("供應商目錄超過 4 MB。");
      let catalog;
      try{catalog=JSON.parse(await file.text());}
      catch{throw new Error("無法讀取供應商目錄，請選擇有效的 JSON 檔。");}
      if(active.current!==job)return;
      let worker;
      try{worker=new PantryWorker();}
      catch{throw new Error(workerUnavailable);}
      job.worker=worker;
      worker.onmessage=event=>finish(event.data);
      worker.onerror=event=>{
        event.preventDefault();
        finish({error:workerUnavailable});
      };
      worker.postMessage({plan,catalog});
    }catch(error){finish({error:error.message});}
  }

  return <section className="prepReadinessFollowup" aria-labelledby="prep-quote-title">
    <h3 id="prep-quote-title">供應商比價</h3>
    <p>依包裝、庫存、運費與免運門檻比較含運總價。供應商目錄在瀏覽器內讀取。</p>
    <div className="actions prepReadinessActions">
      <label>供應商目錄 JSON<input type="file" accept=".json,application/json" onChange={event=>{
        stop();
        setFile(event.currentTarget.files[0]??null);
        setQuote(null);
      }}/></label>
      <button className="primary" type="button" disabled={!file||quote?.loading} onClick={compare}>開始供應商比價</button>
      {quote?.loading&&<button type="button" className="outline" onClick={()=>{stop();setQuote(null);}}>取消比價</button>}
    </div>
    {quote?.loading&&<p role="status">正在試算供應商報價…</p>}
    {quote?.error&&<p className="error" role="alert">{quote.error}</p>}
    {quote?.report&&<QuoteResult report={quote.report} names={new Map(plan.lines.map(line=>[line.component,line.name]))}
      capturedAt={capturedAt}/>}
  </section>;
}
