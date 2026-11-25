const progressLabels={
  pending:"已送單",preparing:"店家接單，開始製作",ready:"餐點已備妥",completed:"已交餐",cancelled:"店家已取消",
};
const cancellationLabels={customer:"顧客已取消",payment_expiry:"付款保留已到期",demo_refund:"店家退款並取消"};
export const progressTime=new Intl.DateTimeFormat("zh-TW",{
  timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
});

export function ProgressTime({at}){
  return at==null?<small>時間未記錄</small>:<time dateTime={new Date(at).toISOString()}>{progressTime.format(at)}</time>;
}

export default function OrderProgress({history}){
  if(!history?.length)return null;
  return <section className="receiptProgress" aria-labelledby="receipt-progress">
    <h2 id="receipt-progress">餐單進度</h2>
    <ol role="list">{history.map(({status,at,actor},index)=><li key={index} aria-current={index===history.length-1?"step":undefined}>
      <span>{status==="cancelled"?(cancellationLabels[actor]??progressLabels[status]):progressLabels[status]}</span>
      <ProgressTime at={at}/>
    </li>)}</ol>
  </section>;
}
