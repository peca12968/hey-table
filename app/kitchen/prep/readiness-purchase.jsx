import {useState} from "react";
import {downloadJson} from "../../../lib/download-json.mjs";

export default function ReadinessPurchase({planner,source,includePreparing}){
  const [result,setResult]=useState(null);
  function calculate(){
    try{
      setResult(planner.purchaseInput(source.orders,includePreparing));
    }catch(error){setResult({error:error.message});}
  }
  const shortages=result?.lines?.filter(line=>line.needed>line.available);
  function download(){
    const {date,station,scope,capturedAt}=source;
    downloadJson("hey-table-prep-purchase-",capturedAt,{
      format:"hey-table.prep-purchase-input.v1",source:{date,station,scope,capturedAt},
      includePreparing,orderCount:result.orderCount,lines:result.lines,
    });
  }
  return <section className="prepReadinessResult prepReadinessFollowup" aria-labelledby="prep-purchase-title">
    <h3 id="prep-purchase-title">採購缺口</h3>
    <p>合併本次試算餐單的用量與半成品批次，再用原盤點庫存推算要補的原料。</p>
    <div className="actions">
      <button className="outline" type="button" onClick={calculate}>計算採購缺口</button>
      {shortages&&<button className="outline" type="button" onClick={download}>下載 Pantry Freight 採購資料</button>}
    </div>
    {result?.error&&<p className="error" role="alert">{result.error}</p>}
    {shortages&&<>
      <p role="status">試算 {result.orderCount} 張餐單 · {shortages.length} 項原料需補貨</p>
      {shortages.length>0&&<ul>{shortages.map(({component,name,unit,needed,available})=><li key={component}>
        <strong>{name} · 缺 {needed-available} {unit}</strong>
        <p>總需求 {needed} {unit} · 盤點庫存 {available} {unit}</p>
      </li>)}</ul>}
    </>}
  </section>;
}
