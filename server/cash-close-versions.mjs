import {cashCorrectionsInRange,dailyCashReceipts} from "./cash-receipts.mjs";
import {reconcileCash} from "../lib/cash-reconciliation.mjs";

const versionFromRow=row=>({date:row.date,revision:row.revision,savedAt:row.saved_at,report:JSON.parse(row.snapshot)});

export async function cashCloseVersions(db,date){
  const {results}=await db.prepare(`SELECT revision,saved_at,
    json_extract(snapshot,'$.totals.receipts') AS receipts,
    json_extract(snapshot,'$.reconciliation') AS reconciliation
    FROM cash_close_versions WHERE date=? ORDER BY revision DESC`).bind(date).all();
  return results.map(row=>({revision:row.revision,savedAt:row.saved_at,receipts:row.receipts,
    reconciliation:JSON.parse(row.reconciliation)}));
}

export async function cashCloseVersion(db,date,revision){
  const row=await db.prepare("SELECT date,revision,saved_at,snapshot FROM cash_close_versions WHERE date=? AND revision=?")
    .bind(date,revision).first();
  return row?versionFromRow(row):null;
}

export async function saveCashClose(db,input,range,now,amounts){
  const {date,revision,operationId,capturedAt,receiptCount,correctionCount=0}=input;
  const [opening,adjustments,counted]=amounts;
  const readOperation=db.prepare("SELECT date,revision,saved_at,snapshot FROM cash_close_versions WHERE operation_id=?").bind(operationId);
  function replay(row){
    const saved=versionFromRow(row),match=saved.report.reconciliation;
    return saved.date===date&&saved.revision===revision+1&&saved.report.capturedAt===capturedAt&&
      saved.report.totals.receipts===receiptCount&&(saved.report.correctionCount??0)===correctionCount&&match.opening===String(opening)&&
      match.adjustments===String(adjustments)&&match.counted===String(counted)?saved:null;
  }
  const already=await readOperation.first();
  if(already)return replay(already);

  const report=await dailyCashReceipts(db,date,range,capturedAt);
  if(report.totals.receipts!==receiptCount||(report.correctionCount??0)!==correctionCount)return null;
  const reconciliation=reconcileCash(report.totals.net,opening,adjustments,counted);
  const [,lookup]=await db.batch([
    db.prepare(`INSERT INTO cash_close_versions(date,revision,operation_id,saved_at,snapshot)
      SELECT ?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM cash_close_versions WHERE date=?),0)=?
      AND (SELECT COUNT(*) FROM cash_receipts WHERE collected_at>=? AND collected_at<?)=?
      AND (${cashCorrectionsInRange})=?
      ON CONFLICT DO NOTHING`).bind(date,revision+1,operationId,now,JSON.stringify({...report,reconciliation}),
      date,revision,...range,receiptCount,...range,correctionCount),
    readOperation,
  ]);
  return lookup.results[0]?replay(lookup.results[0]):null;
}
