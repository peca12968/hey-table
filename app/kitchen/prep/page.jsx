"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {dishes} from "../../../lib/menu.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
import {PickupDate} from "../../pickup-slots";
import {useBusinessToday} from "../../use-business-today.mjs";
import "./prep.css";

const names = new Map(dishes.map(dish => [dish.id, dish.name]));
const taipei = new Intl.DateTimeFormat("zh-TW", {
  timeZone:"Asia/Taipei", dateStyle:"medium", timeStyle:"medium"
});

function totals(orders) {
  const counts = new Map();
  for (const order of orders) {
    for (const {id,qty} of order.items) {
      const count = counts.get(id) ?? {pending:0, preparing:0};
      count[order.status] += qty;
      counts.set(id, count);
    }
  }
  return Array.from(counts);
}

export default function Prep() {
  const [view,setView] = useState(null);
  const [revision,setRevision] = useState(0);
  const [day,setDay] = useState("");
  const [remainingOnly,setRemainingOnly] = useState(false);
  const today=useBusinessToday();
  const date=day||today;
  useEffect(() => {
    if(!date)return;
    const controller=new AbortController();
    const key = sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/prep?date="+encodeURIComponent(date)+"&stationProgress=1", {
      headers:key?{Authorization:"Bearer "+key}:{},
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
    }).then(snapshot=>{if(!controller.signal.aborted)setView({date,revision,snapshot});})
      .catch(failure=>{if(!controller.signal.aborted)setView({date,revision,
        error:failure.name==="TimeoutError"?"讀取備料單逾時，請重新擷取。":failure.message});});
    return () => controller.abort();
  }, [date,revision]);
  const current=view?.date===date&&view.revision===revision?view:null;
  const snapshot=current?.snapshot;
  const error=current?.error;
  const orders=snapshot&&(remainingOnly?snapshot.remainingOrders:snapshot.orders);
  const rangeLabel=remainingOnly?"未完成品項":"完整餐單";

  return <><Header/><main className="shell section prep">
    <a href="/kitchen" className="textLink prepControl">返回店家接單台</a>
    <h1>廚房備料單</h1>
    <div className="prepControl"><PickupDate label="備料日期" value={day} onChange={setDay}/></div>
    {error && <p role="alert" className="error">{error}</p>}
    {!error && !snapshot && <p role="status">正在讀取備料單…</p>}
    {snapshot && <>
      <p>備料日期 {snapshot.date}</p>
      <p>擷取時間（台北）　<time dateTime={new Date(snapshot.capturedAt).toISOString()}>{taipei.format(snapshot.capturedAt)}</time></p>
      <fieldset className="prepControl prepScope">
        <legend>備料範圍</legend>
        <label><input type="radio" name="prep-scope" checked={!remainingOnly} onChange={()=>setRemainingOnly(false)}/>完整餐單</label>
        <label><input type="radio" name="prep-scope" checked={remainingOnly} onChange={()=>setRemainingOnly(true)}/>未完成品項</label>
      </fieldset>
      <p>{remainingOnly?"未完成品項會扣除各分站已回報備妥的餐點。":"完整餐單列出待接單與製作中餐單的所有品項，供核對領料。"}</p>
      {orders.length ? <table><caption>{rangeLabel} · 餐點需求（份）</caption>
        <thead><tr><th scope="col">餐點</th><th scope="col">待接單</th><th scope="col">製作中</th></tr></thead>
        <tbody>{totals(orders).map(([id,count]) => <tr key={id}>
          <th scope="row">{names.get(id) ?? id}</th><td>{count.pending}</td><td>{count.preparing}</td>
        </tr>)}</tbody></table> : <p className="sheet">目前沒有待接單或製作中的餐點。</p>}
    </>}
    <div className="actions prepControl">
      <button className="outline" disabled={!current} onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
      {snapshot && <>
        <button className="outline" onClick={() => window.print()}>列印備料單</button>
        <button className="primary" onClick={() => downloadJson(remainingOnly?"hey-table-prep-remaining-":"hey-table-prep-",snapshot.capturedAt,orders)}>下載訂單 JSON</button>
      </>}
    </div>
    <p className="prepControl"><a className="textLink" href="https://github.com/peca12968/hey-table/blob/main/modules/prep-sheet/README.md#從訂單匯出試算採購">備料與採購試算說明</a></p>
  </main><Footer/></>;
}
