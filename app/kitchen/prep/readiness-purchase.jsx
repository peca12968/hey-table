import {useState} from "react";
import {downloadJson} from "../../../lib/download-json.mjs";
import PurchaseQuote from "./purchase-quote.jsx";

export default function ReadinessPurchase({planner,source,orders,ledger,includePreparing}){
  const [result,setResult]=useState(null);
  function calculate(){
    try{
      setResult(planner.purchaseInput(orders,includePreparing));
    }catch(error){setResult({error:error.message});}
  }
  const shortages=result?.lines?.filter(line=>line.needed>line.available);
  const review=result?.lines?.filter(line=>line.needed>line.available||line.incoming>0);
  function download(){
    const {date,station,scope,capturedAt}=source;
    downloadJson("hey-table-prep-purchase-",capturedAt,{
      format:"hey-table.prep-purchase-input.v1",source:{date,station,scope,capturedAt},
      includePreparing,orderCount:result.orderCount,lines:result.lines,
      ...(ledger?{purchaseOrders:ledger.purchaseOrders}:{}),
    });
  }
  return <section className="prepReadinessResult prepReadinessFollowup" aria-labelledby="prep-purchase-title">
    <h3 id="prep-purchase-title">採購缺口</h3>
    <p>合併本次試算餐單的用量與半成品批次，依現貨與已確認的在途量推算要補的原料。</p>
    {ledger?.purchaseOrders.length>0&&<p>計入在途採購單 {ledger.purchaseOrders.join("、")}</p>}
    <div className="actions">
      <button className="outline" type="button" onClick={calculate}>計算採購缺口</button>
      {shortages&&<button className="outline" type="button" onClick={download}>下載 Pantry Freight 採購資料</button>}
    </div>
    {result?.error&&<p className="error" role="alert">{result.error}</p>}
    {shortages&&<>
      <p role="status">試算 {result.orderCount} 張餐單 · {shortages.length} 項原料需補貨</p>
      {review.length>0&&<ul>{review.map(({component,name,unit,needed,available,on_hand,incoming})=><li key={component}>
        <strong>{name} · {needed>available?"缺 "+(needed-available)+" "+unit:"現貨與在途已涵蓋"}</strong>
        <p>總需求 {needed} {unit} · 盤點庫存 {on_hand??available} {unit}
          {incoming>0&&" · 在途 "+incoming+" "+unit}</p>
      </li>)}</ul>}
      {shortages.length>0&&<PurchaseQuote plan={result} capturedAt={source.capturedAt}/>}
    </>}
  </section>;
}
