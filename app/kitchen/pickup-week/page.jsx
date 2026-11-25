"use client";

import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {businessDayRange} from "../../../lib/business-day.mjs";
import {pickupRosterPath,pickupSettingsPath} from "../../../lib/pickup-slots.mjs";
import "./week.css";

const path="/kitchen/pickup-week";
const taipei={timeZone:"Asia/Taipei"};
const dayLabel=new Intl.DateTimeFormat("zh-TW",{...taipei,month:"numeric",day:"numeric",weekday:"short"});
const capturedLabel=new Intl.DateTimeFormat("zh-TW",{...taipei,dateStyle:"short",timeStyle:"medium"});

function WeekDay({day}){
  const heading=dayLabel.format(businessDayRange(day.date)[0]);
  return <li className="sheet pickupWeekDay">
    <div className="pickupWeekDate">
      <h2><time dateTime={day.date}>{heading}</time></h2>
      <span>{day.ended?"已截止":day.accepting?"開放預約":"整日停收"}</span>
    </div>
    <dl className="pickupWeekMetrics">
      <div><dt>有效預約</dt><dd>{day.bookings} 張</dd></div>
      <div><dt>已占用</dt><dd>{day.portions} 份</dd></div>
      {day.accepting&&!day.ended&&<>
        <div><dt>可預約時段</dt><dd>{day.available}</dd></div>
        <div><dt>滿額時段</dt><dd>{day.full}</dd></div>
        <div><dt>停收時段</dt><dd>{day.closed}</dd></div>
      </>}
    </dl>
    <div className="actions">
      <a className="outline" href={pickupRosterPath(day.date)} aria-label={heading+"的預約清單"}>預約清單</a>
      <a className="outline" href={pickupSettingsPath(day.date)} aria-label={heading+"的時段設定"}>時段設定</a>
    </div>
  </li>;
}

export default function PickupWeek(){
  const [revision,setRevision]=useState(0),[view,setView]=useState(null);
  useEffect(()=>{
    const controller=new AbortController(),key=sessionStorage.getItem("he-ri-staff");
    request("/api"+path,{headers:key?{Authorization:"Bearer "+key}:{},
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])}).then(snapshot=>{
      if(!controller.signal.aborted)setView({revision,snapshot});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({revision,denied:error.status===403,
        error:error.name==="TimeoutError"?"讀取總覽逾時，請重新擷取。":error.message});
    });
    return ()=>controller.abort();
  },[revision]);
  const current=view?.revision===revision?view:null,snapshot=current?.snapshot;
  return <><Header/><main className="shell section pickupWeek">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>七天自取預約總覽</h1>
    <div className="actions pickupWeekControls">
      {snapshot&&<p>台北擷取時間 <time dateTime={new Date(snapshot.capturedAt).toISOString()}>{capturedLabel.format(snapshot.capturedAt)}</time></p>}
      <button className="outline" disabled={!current} onClick={()=>setRevision(value=>value+1)}>重新擷取</button>
    </div>
    {!current&&<p role="status">正在讀取預約總覽…</p>}
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.denied&&<a className="primary" href={"/signin-with-chatgpt?return_to="+encodeURIComponent(path)} target="_top">使用 ChatGPT 登入</a>}
    {snapshot&&<>
      {!snapshot.onlineAccepting&&<p className="sheet">線上自取接單暫停。店員仍可依日期和時段設定代建預約。</p>}
      <p className="muted">可預約時段依上限與截止時間計算，送單時也會檢查餐點供應量。</p>
      <ul className="pickupWeekList">{snapshot.days.map(day=><WeekDay key={day.date} day={day}/>)}</ul>
    </>}
  </main><Footer/></>;
}
