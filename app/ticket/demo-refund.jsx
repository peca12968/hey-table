"use client";

import {useState} from "react";
import {downloadFile} from "../../lib/download-file.mjs";
import {numberOf} from "../../lib/menu.mjs";

const taipeiTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"medium"});

export default function DemoRefund({order,token}){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const refund=order.demoRefund;

  async function download(){
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/ticket/refund-receipt",{headers:{"X-Ticket":token},cache:"no-store",signal:AbortSignal.timeout(15_000)});
      if(!response.ok||!response.headers.get("Content-Type")?.startsWith("text/plain"))throw new Error();
      downloadFile(await response.blob(),"hey-table-refund-"+numberOf(order.id)+".txt");
    }catch{setError("暫時無法下載退款收據，請再試一次。");}
    finally{setBusy(false);}
  }

  return <>
    <p>已模擬全額退款 NT$ {refund?.amount??order.total}。</p>
    {refund&&<>
      <p>退款時間（台灣） {refund.refundedAt===null?"未記錄":
        <time dateTime={new Date(refund.refundedAt).toISOString()}>{taipeiTime.format(refund.refundedAt)}</time>}</p>
      <button className="outline" type="button" disabled={busy} onClick={download}>{busy?"正在下載…":"下載示範退款收據"}</button>
    </>}
    {error&&<p role="alert">{error}</p>}
  </>;
}
