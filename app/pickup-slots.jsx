import {useEffect,useId,useState} from "react";
import {pickupBookingDays,pickupWindow} from "../lib/pickup-slots.mjs";
import {businessDayRange} from "../lib/business-day.mjs";
import {request} from "./shared";
import {useBusinessToday} from "./use-business-today.mjs";

export function PickupDate({value,disabled,onChange,label="取餐日期",paused=false}){
  const id=useId();
  const today=useBusinessToday();
  const future=today?pickupBookingDays(businessDayRange(today)[0]).slice(1):[];
  return <div className="pickupDate">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value===today?"":value} disabled={disabled} onChange={event=>onChange(event.target.value)}>
      <option value="">{today?"今天 · "+today:"今天"}</option>
      {value&&value!==today&&!future.includes(value)&&<option value={value}>{value}（已過期）</option>}
      {future.map(day=><option key={day} value={day}>{day}</option>)}
    </select>
    {paused&&<p className="muted" role="status">{!value||value===today?
      "今天已暫停時段預約，仍可選擇盡快自取。":"這個日期已暫停預約，請改選日期。"}</p>}
  </div>;
}

export default function PickupSlots({selected,count,disabled,onChange,revision,day=""}){
  const [expanded,setExpanded]=useState(false);
  const [snapshot,setSnapshot]=useState(null);
  const [error,setError]=useState("");
  const [reload,setReload]=useState(0);
  const opened=expanded||selected!==null||!!day;
  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();
    request("/api/pickup-slots"+(day?"?date="+day:""),{signal:controller.signal}).then(({slots,paused})=>{
      if(!controller.signal.aborted){setSnapshot({day,slots,paused});setError("");}
    }).catch(()=>{
      if(!controller.signal.aborted){setSnapshot(null);setError("暫時無法讀取自取時段。");}
    });
    return ()=>controller.abort();
  },[day,opened,reload,revision]);
  if(!opened)return <button type="button" className="outline pickupSlotsButton" disabled={disabled}
    onClick={()=>setExpanded(true)}>預約取餐時段</button>;

  const current=snapshot?.day===day?snapshot:null;
  const slots=current?.slots??[];
  const match=slots.find(slot=>slot.start===selected);
  const available=slots.some(slot=>slot.remaining>=count);
  const needsChoice=current!==null&&selected!==null&&(!match||match.remaining<count);
  return <section className="pickupSlots" aria-label="預約取餐">
    {day&&<p className="muted">預約日期 {day}</p>}
    <label>自取時段<select value={selected??""} disabled={disabled} onChange={event=>{
      setExpanded(true);
      onChange(event.target.value===""?null:Number(event.target.value));
    }}>
      <option value="">{day?"選擇時段":"盡快自取"}</option>
      {selected!==null&&!match&&<option value={selected}>{pickupWindow(selected)}</option>}
      {slots.map(({start,remaining})=><option key={start} value={start} disabled={start!==selected&&remaining<count}>
        {pickupWindow(start)} · 剩 {remaining} 份
      </option>)}
    </select></label>
    {disabled?null:<>
      <p className="muted">台灣時間，至少提前 30 分鐘。</p>
      {current?.paused&&<p role="status">這個日期已暫停時段預約。</p>}
      {!current?.paused&&needsChoice&&<p role="status">請重新選擇可容納這張餐單的時段。</p>}
      {!needsChoice&&current&&!available&&!current.paused&&<p role="status">目前沒有可容納這張餐單的預約時段。</p>}
      {error?<p role="status">{error} <button className="outline" type="button" onClick={()=>setReload(value=>value+1)}>重讀時段</button></p>:
        !current&&<p role="status">正在讀取時段…</p>}
    </>}
  </section>;
}
