import {useRef,useState} from "react";
import {downloadJson} from "../../../lib/download-json.mjs";
import {readReceivingStatus,receivingDraft,receivingStateLabels} from "../../../lib/prep-receiving.mjs";

export default function ReceivingReview(){
  const [file,setFile]=useState(null);
  const [supplier,setSupplier]=useState("");
  const [deliveryId,setDeliveryId]=useState("");
  const [entries,setEntries]=useState(()=>new Map());
  const [preview,setPreview]=useState(null);
  const operation=useRef(0);

  function clearDraft(){
    setDeliveryId("");
    setEntries(new Map());
    setPreview(null);
  }
  async function readFile(event){
    const input=event.currentTarget,selection=input.files[0];
    input.value="";
    if(!selection)return;
    const version=++operation.current;
    clearDraft();
    if(selection.size>4*1024*1024){
      setFile({error:"採購單狀態檔超過 4 MB。"});
      return;
    }
    setFile({loading:true});
    try{
      const report=readReceivingStatus(JSON.parse(await selection.text()));
      if(version!==operation.current)return;
      setSupplier((report.lines.find(row=>row.remaining_packs>0)??report.lines[0]).supplier);
      setFile({report});
    }catch{
      if(version===operation.current)setFile({error:"無法讀取採購單狀態。請選擇 receiving.py status 匯出的 JSON。"});
    }
  }
  function previewReceipt(event){
    event.preventDefault();
    try{setPreview({draft:receivingDraft(file.report,supplier,deliveryId,entries)});}
    catch(error){setPreview({error:error.message});}
  }
  const report=file?.report;
  const listed=report?.lines.filter(row=>row.supplier===supplier)??[];
  const reference=preview?.draft;
  const total=reference?.lines.reduce((sum,line)=>sum+line.packs,0);
  return <section className="sheet prepControl prepReceiving" id="prep-receiving" aria-labelledby="prep-receiving-title">
    <h2 id="prep-receiving-title">到貨驗收核對</h2>
    <p>選取 SQLite 帳本匯出的採購單狀態，核對實收包數並下載草稿。草稿可交給帳本入庫。</p>
    <div className="actions prepReadinessActions">
      <label>採購單狀態 JSON<input type="file" accept=".json,application/json" onChange={readFile}/></label>
    </div>
    {file?.loading&&<p role="status">正在讀取採購單狀態…</p>}
    {file?.error&&<p className="error" role="alert">{file.error}</p>}
    {report&&<>
      <p>採購單 {report.purchase_order} · {receivingStateLabels[report.state]} · 全單待收 {report.remaining_packs} 包</p>
      <form onSubmit={previewReceipt}>
        <div className="actions prepReadinessActions prepReceivingFields">
          <div>
            <label htmlFor="prep-receiving-supplier">驗收供應商</label>
            <select id="prep-receiving-supplier" value={supplier} onChange={event=>{
              setSupplier(event.currentTarget.value);
              clearDraft();
            }}>
              {[...new Set(report.lines.map(row=>row.supplier))].map(id=><option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <label>送貨單號<input value={deliveryId} onChange={event=>{
            setDeliveryId(event.currentTarget.value);
            setPreview(null);
          }}/></label>
        </div>
        <ul className="prepReceivingLines">{listed.map(row=><li key={row.sku}>
          <strong>{row.sku} · {row.component} · 每包 {row.pack} {row.unit}</strong>
          <p>已訂 {row.ordered_packs} · 已收 {row.received_packs} · 已取消 {row.cancelled_packs} · 待收 {row.remaining_packs} 包</p>
          {row.remaining_packs>0&&<label>實收 {row.sku} 包數<input inputMode="numeric" value={entries.get(row.sku)??""}
            onChange={event=>{
              const {value}=event.currentTarget;
              setEntries(previous=>new Map(previous).set(row.sku,value));
              setPreview(null);
            }}/></label>}
        </li>)}</ul>
        <button type="submit" className="primary" disabled={!listed.some(row=>row.remaining_packs>0)}>核對實收包數</button>
      </form>
    </>}
    {preview?.error&&<p className="error" role="alert">{preview.error}</p>}
    {reference&&<section aria-label="驗收草稿">
      <p role="status">送貨單 {reference.delivery_id} · 本次實收 {total} 包</p>
      <ul className="prepReceivingLines">{reference.lines.map(line=><li key={line.sku}>
        {line.sku} · {line.packs} 包 · {String(BigInt(line.pack)*BigInt(line.packs))} {line.unit} · 入庫後待收 {line.remaining_packs-line.packs} 包
      </li>)}</ul>
      <button type="button" className="outline" onClick={()=>
        downloadJson("hey-table-receiving-draft-",Date.now(),reference)}>下載驗收草稿</button>
    </section>}
  </section>;
}
