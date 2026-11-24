"use client";
import {useState} from "react";
import {request} from "../shared";
import {downloadJson} from "../../lib/download-json.mjs";

export default function PaymentSnapshot({staffKey}) {
  const [environment, setEnvironment] = useState("sandbox");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function download(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const snapshot = await request("/api/kitchen/payment-snapshot?environment=" + environment, {
        headers: staffKey ? {Authorization: "Bearer " + staffKey} : {},
      });
      downloadJson("hey-table-payments-" + environment + "-", snapshot.capturedAt, snapshot);
      setMessage("已下載 " + snapshot.attempts.length + " 筆付款嘗試。");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <details className="sheet">
    <summary>匯出付款對帳快照</summary>
    <p>下載指定環境的線上付款嘗試，供 Payout Ledger 核對請款與退款。</p>
    <form className="actions" onSubmit={download}>
      <label>金流環境 <select className="outline" value={environment} disabled={busy} onChange={event => setEnvironment(event.target.value)}>
        <option value="sandbox">商戶測試</option>
        <option value="production">正式金流</option>
      </select></label>
      <button className="outline" disabled={busy}>{busy ? "正在匯出…" : "下載付款快照 JSON"}</button>
    </form>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </details>;
}
