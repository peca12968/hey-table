import {datedPickupWindow,pickupChangeActor} from "../lib/pickup-slots.mjs";
import {ProgressTime} from "./order-progress";

function Window({start}){
  return <time className="pickupHistoryWindow" dateTime={new Date(start).toISOString()}>{datedPickupWindow(start)}</time>;
}

export default function PickupChangeHistory({order}){
  const {pickupSlot,pickupChanges:changes,status}=order;
  if(pickupSlot==null||!changes?.length)return null;
  return <details className="receiptProgress pickupHistory">
    <summary>改期歷程（{changes.length} 次）</summary>
    <dl>
      <div><dt>最初預約</dt><dd><Window start={changes[0].from}/></dd></div>
      <div><dt>{status==="cancelled"?"取消前預約":status==="completed"?"最後預約":"目前預約"}</dt>
        <dd><Window start={pickupSlot}/></dd></div>
    </dl>
    <ol reversed role="list" aria-label="改期紀錄">
      {changes.map((change,index)=><li key={index}>
        <div className="pickupHistoryMeta"><strong>第 {index+1} 次 · {pickupChangeActor(change)}改期</strong>
          <ProgressTime at={change.at}/></div>
        <div className="pickupHistoryRoute">
          <span>從 <Window start={change.from}/></span><span>改到 <Window start={change.to}/></span>
        </div>
      </li>).reverse()}
    </ol>
  </details>;
}
