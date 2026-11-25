"use client";

import TextDownload from "./text-download";

const taipeiTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"medium"});

export default function DemoRefund({order,token}){
  const refund=order.demoRefund;

  return <>
    <p>已模擬全額退款 NT$ {refund?.amount??order.total}。</p>
    {refund&&<>
      <p>退款時間（台灣） {refund.refundedAt===null?"未記錄":
        <time dateTime={new Date(refund.refundedAt).toISOString()}>{taipeiTime.format(refund.refundedAt)}</time>}</p>
      <TextDownload kind="refund" token={token} id={order.id}/>
    </>}
  </>;
}
