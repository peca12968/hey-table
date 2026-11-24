# Burn Pair｜結帳服務的錯誤預算何時需要叫醒值班員？

服務短時間出現 10% 的 HTTP 5xx，和持續數小時出現 0.7% 的 5xx，是不同的事故。Burn Pair 將 99.9% 請求成功率目標轉成 Prometheus 規則，以成對的時間窗決定是否通知值班員，並另外回報觀測資料中斷的服務實例。

## 重跑告警時間線

使用 Python 3.11 以上，可在 x86-64 Linux 或 Windows 下載與 CI 相同的 Prometheus 3.16.0 工具。安裝程式會核對官方發行檔的 SHA-256。若已有 promtool，也可直接提供該執行檔路徑。

```sh
python install_promtool.py .tools
python verify.py .tools/promtool
```

Windows 最後一行使用 `python verify.py .tools/promtool.exe`。每個案例產生 421 個間隔一分鐘的計數器取樣點，由 promtool 的規則引擎實際運算。

| 合成流量 | 規則判定 |
| --- | --- |
| 每分鐘 1,000 筆，最後四分鐘各有 100 筆 5xx | 短窗超標，長窗未超標，沒有叫人 |
| 錯誤率維持 0.7% 七小時 | 慢速消耗條件成立，發出一個服務告警 |
| 第 241 至 320 分鐘持續 2% 失敗，其他時間皆成功 | 第 283 分鐘尚未觸發，284 分鐘觸發，321 分鐘仍在告警，322 分鐘解除 |
| 一個實例每分鐘成功 999 筆，另一個失敗 1 筆 | 即使忙碌實例中途重新啟動，整體錯誤率仍為 0.1% |
| 閒置實例仍送出計數器，另一個實例停止回報 | 只有停止回報的實例產生遙測警告 |

## 接上服務指標

將 `rules.yml` 加入 Prometheus 的 `rule_files`。規則預期 `http_requests_total` 是單調累加的計數器，具有 `service`、`instance` 及三位數 HTTP `status` 標籤。每個請求計一次，5xx 算失敗；4xx 計入請求總數。服務名稱需能在此規則涵蓋的環境中唯一識別。請從獨立的目標清單提供 `slo_target_expected{service,instance} 1`，並讓新啟動的服務在尚未處理請求時也能送出初始計數器。

先對各實例的序列計算 rate，再按服務加總並相除。容許錯誤率為 0.1%。5 分鐘與 1 小時兩窗都高於 1.44% 時，代表以 14.4 倍速率消耗預算；30 分鐘與 6 小時都高於 0.6% 時，則是 6 倍。任一組成立就產生同一個服務告警，兩組同時成立仍只有一個。新序列的長窗可能只有部分歷史；沒有流量時比率無定義，預期目標連續五分鐘沒有計數器取樣則由獨立規則識別。[規則](rules.yml) · [Prometheus 規則測試](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/) · [Google SRE 的多視窗設計](https://sre.google/workbook/alerting-on-slos/)

時間點來自隨附的合成流量與一分鐘的取樣及規則評估間隔。本專案使用 AI 輔助開發。[完整重現程式](verify.py)
