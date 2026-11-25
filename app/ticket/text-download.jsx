"use client";

import {useState} from "react";
import {downloadFile} from "../../lib/download-file.mjs";
import {numberOf} from "../../lib/menu.mjs";

const documents={
  order:{path:"order-details",label:"下載餐單明細",error:"暫時無法下載餐單明細，請再試一次。"},
  refund:{path:"refund-receipt",label:"下載示範退款收據",error:"暫時無法下載退款收據，請再試一次。"},
};

export default function TextDownload({kind,token,id}){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const descriptor=documents[kind];
  async function download(){
    if(busy)return;
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/ticket/"+descriptor.path,{headers:{"X-Ticket":token},cache:"no-store",
        signal:AbortSignal.timeout(15_000)});
      if(!response.ok||!response.headers.get("Content-Type")?.startsWith("text/plain"))throw new Error();
      downloadFile(await response.blob(),"hey-table-"+kind+"-"+numberOf(id)+".txt");
    }catch{setError(descriptor.error);}
    finally{setBusy(false);}
  }
  return <div className="ticketTextDownload">
    <button className="outline" type="button" disabled={busy} onClick={download}>{busy?"正在下載…":descriptor.label}</button>
    {error&&<p role="alert">{error}</p>}
  </div>;
}
