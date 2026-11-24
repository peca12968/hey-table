"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {dishes} from "../../../lib/menu.mjs";
import {downloadJson} from "../../../lib/download-json.mjs";
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
  const [snapshot,setSnapshot] = useState(null);
  const [revision,setRevision] = useState(0);
  const [error,setError] = useState("");
  useEffect(() => {
    let live = true;
    const key = sessionStorage.getItem("he-ri-staff");
    request("/api/kitchen/prep", {headers:key ? {Authorization:"Bearer " + key} : {}})
      .then(value => {if (live) setSnapshot(value);})
      .catch(err => {if (live) setError(err.message);});
    return () => {live = false;};
  }, [revision]);
  function refresh() {
    setError("");
    setSnapshot(null);
    setRevision(value => value + 1);
  }
  return <><Header/><main className="shell section prep">
    <a href="/kitchen" className="textLink prepControl">返回店家接單台</a>
    <h1>廚房備料單</h1>
    {error && <p role="alert" className="error">{error}</p>}
    {!error && !snapshot && <p role="status">正在讀取備料單…</p>}
    {snapshot && <>
      <p>擷取時間（台北）　<time dateTime={new Date(snapshot.capturedAt).toISOString()}>{taipei.format(snapshot.capturedAt)}</time></p>
      <p>待接單的餐點可用來估算備料。製作中的餐點另列，方便核對已領用的食材。</p>
      {snapshot.orders.length ? <table><caption>餐點需求（份）</caption>
        <thead><tr><th scope="col">餐點</th><th scope="col">待接單</th><th scope="col">製作中</th></tr></thead>
        <tbody>{totals(snapshot.orders).map(([id,count]) => <tr key={id}>
          <th scope="row">{names.get(id) ?? id}</th><td>{count.pending}</td><td>{count.preparing}</td>
        </tr>)}</tbody></table> : <p className="sheet">目前沒有待接單或製作中的餐點。</p>}
    </>}
    <div className="actions prepControl">
      <button className="outline" disabled={!snapshot && !error} onClick={refresh}>重新擷取</button>
      {snapshot && <>
        <button className="outline" onClick={() => window.print()}>列印備料單</button>
        <button className="primary" onClick={() => downloadJson("hey-table-prep-",snapshot.capturedAt,snapshot.orders)}>下載訂單 JSON</button>
      </>}
    </div>
    <p className="prepControl"><a className="textLink" href="https://github.com/peca12968/hey-table/blob/main/modules/prep-sheet/README.md#從訂單匯出試算採購">備料與採購試算說明</a></p>
  </main><Footer/></>;
}
