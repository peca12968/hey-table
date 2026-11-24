"use client";
import {useEffect,useRef,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {numberOf} from "../../../lib/menu.mjs";
import "./display.css";

const displayTime=new Intl.DateTimeFormat("zh-TW",{
  timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
});
const networkError="暫時無法更新取餐號碼，請向櫃台確認。";

function OrderNumbers({title,numbers,ready=false}){
  return <section className={ready?"pickupReady":"pickupPreparing"} aria-label={title}>
    <h2>{title}</h2>
    {numbers.length?<ul>{numbers.map(id=><li key={id}>{numberOf(id)}</li>)}</ul>:
      <p>{ready?"目前沒有待取餐號碼。":"目前沒有製作中的自取餐單。"}</p>}
  </section>;
}

export default function PickupDisplay(){
  const screen=useRef(null);
  const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(""),[revision,setRevision]=useState(0);
  const [fullscreen,setFullscreen]=useState(false),[canFullscreen,setCanFullscreen]=useState(false);
  const [displayMessage,setDisplayMessage]=useState("");
  useEffect(()=>{
    setCanFullscreen(document.fullscreenEnabled&&typeof screen.current?.requestFullscreen==="function");
    const sync=()=>setFullscreen(document.fullscreenElement===screen.current);
    document.addEventListener("fullscreenchange",sync);
    return ()=>document.removeEventListener("fullscreenchange",sync);
  },[]);
  useEffect(()=>{
    let active,closed=false;
    async function load(){
      if(active)return;
      const controller=new AbortController();
      active=controller;
      const deadline=setTimeout(()=>controller.abort(),4000);
      try{
        const key=sessionStorage.getItem("he-ri-staff");
        const result=await request("/api/kitchen/pickup-display",{
          signal:controller.signal,headers:key?{Authorization:"Bearer "+key}:{},
        });
        if(!closed&&!controller.signal.aborted){setSnapshot(result);setError("");}
      }catch(failure){
        if(!closed){
          setSnapshot(null);
          setError(failure.status===403?"請登入店家接單台以開啟看板。":networkError);
        }
      }finally{
        clearTimeout(deadline);
        active=null;
      }
    }
    function offline(){
      active?.abort();
      setSnapshot(null);
      setError(networkError);
    }
    load();
    const timer=setInterval(load,5000);
    window.addEventListener("offline",offline);
    window.addEventListener("online",load);
    return ()=>{
      closed=true;active?.abort();clearInterval(timer);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",load);
    };
  },[revision]);
  async function toggleFullscreen(){
    setDisplayMessage("");
    try{
      if(fullscreen)await document.exitFullscreen();
      else await screen.current.requestFullscreen();
    }catch{
      setDisplayMessage("目前無法切換全螢幕。");
    }
  }
  return <><Header/><main className="shell section pickupDisplay" ref={screen}>
    <div className="pickupDisplayHead">
      <div><a className="textLink" href="/kitchen">返回店家接單台</a><h1>櫃台取餐看板</h1></div>
      <div className="actions">
        <button className="outline" onClick={()=>setRevision(value=>value+1)}>更新看板</button>
        {canFullscreen&&<button className="outline" onClick={toggleFullscreen}>{fullscreen?"離開全螢幕":"全螢幕"}</button>}
      </div>
    </div>
    {displayMessage&&<p role="status">{displayMessage}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {!snapshot&&!error&&<p role="status">正在讀取取餐號碼…</p>}
    {snapshot&&<>
      <p className="pickupDisplayUpdated">更新時間 <time dateTime={new Date(snapshot.capturedAt).toISOString()}>{displayTime.format(snapshot.capturedAt)}</time></p>
      <div className="pickupDisplayPanels">
        <OrderNumbers title="請取餐" numbers={snapshot.ready} ready/>
        <OrderNumbers title="製作中" numbers={snapshot.preparing}/>
      </div>
    </>}
  </main><Footer/></>;
}
