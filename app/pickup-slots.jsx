import {useEffect,useState} from "react";
import {pickupWindow} from "../lib/pickup-slots.mjs";
import {request} from "./shared";

export default function PickupSlots({selected,count,disabled,onChange,revision}){
  const [expanded,setExpanded]=useState(false);
  const [snapshot,setSnapshot]=useState(null);
  const [error,setError]=useState("");
  const [reload,setReload]=useState(0);
  const opened=expanded||selected!==null;
  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();
    request("/api/pickup-slots",{signal:controller.signal}).then(({slots})=>{
      if(!controller.signal.aborted){setSnapshot(slots);setError("");}
    }).catch(()=>{
      if(!controller.signal.aborted){setSnapshot(null);setError("暫時無法讀取自取時段。");}
    });
    return ()=>controller.abort();
  },[opened,reload,revision]);
  if(!opened)return <button type="button" className="outline pickupSlotsButton" disabled={disabled}
    onClick={()=>setExpanded(true)}>預約取餐時段</button>;

  const slots=snapshot??[];
  const match=slots.find(slot=>slot.start===selected);
  const available=slots.some(slot=>slot.remaining>=count);
  const needsChoice=snapshot!==null&&selected!==null&&(!match||match.remaining<count);
  return <section className="pickupSlots" aria-label="預約取餐">
    <label>自取時段<select value={selected??""} disabled={disabled} onChange={event=>{
      setExpanded(true);
      onChange(event.target.value===""?null:Number(event.target.value));
    }}>
      <option value="">盡快自取</option>
      {selected!==null&&!match&&<option value={selected}>{pickupWindow(selected)}</option>}
      {slots.map(({start,remaining})=><option key={start} value={start} disabled={start!==selected&&remaining<count}>
        {pickupWindow(start)} · 剩 {remaining} 份
      </option>)}
    </select></label>
    {disabled?null:<>
      <p className="muted">台灣時間，至少提前 30 分鐘。</p>
      {needsChoice&&<p role="status">請重新選擇可容納這張餐單的時段。</p>}
      {!needsChoice&&snapshot&&!available&&<p role="status">目前沒有可容納這張餐單的預約時段。</p>}
      {error?<p role="status">{error} <button className="outline" type="button" onClick={()=>setReload(value=>value+1)}>重讀時段</button></p>:
        !snapshot&&<p role="status">正在讀取時段…</p>}
    </>}
  </section>;
}
