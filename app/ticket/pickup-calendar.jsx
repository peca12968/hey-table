import {useState} from "react";
import {downloadFile} from "../../lib/download-file.mjs";
import {numberOf} from "../../lib/menu.mjs";

export default function PickupCalendar({id,token,status,onChange}){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  async function download(){
    if(busy)return;
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/ticket/calendar",{headers:{"X-Ticket":token},cache:"no-store",signal:AbortSignal.timeout(15_000)});
      if(response.status===409){
        setError("付款狀態已更新，請核對收據。");
        onChange();
        return;
      }
      if(!response.ok||!response.headers.get("Content-Type")?.startsWith("text/calendar"))throw new Error();
      downloadFile(await response.blob(),"hey-table-pickup-"+numberOf(id)+".ics");
    }catch{setError("暫時無法下載行事曆檔，請再試一次。");}
    finally{setBusy(false);}
  }
  return <div className="pickupCalendar">
    <button className="outline" type="button" disabled={busy} onClick={download}>
      {busy?"正在下載…":status==="CANCELLED"?"下載取消行事曆檔":"下載取餐行事曆檔"}
    </button>
    {error&&<p className="error" role="alert">{error}</p>}
  </div>;
}
