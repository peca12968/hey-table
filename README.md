# Stockroom Kubernetes Drill｜庫存服務的 Pod 重建演練

顧客保留了 7 件商品，此時維運人員重新部署服務。新的 Pod 接到同一筆訂單時，應讀回原保留，庫存仍是 13 件。這個專案把 Stockroom 原有的容器部署到一次性的單節點 kind 叢集，從另一個 Pod 透過 Service 送出真實 HTTP 請求，核對應用程式與儲存層的結果。

## 重現演練

需要可執行 Linux 容器的 Docker、Git、Python 3.10 以上、kind 與 kubectl。CI 使用 kind 0.33.0 和 kubectl 1.37.0。在本專案的目錄中執行以下指令。

```sh
git clone https://github.com/peca12968/hey-table.git ../stockroom-demo
python drill.py ../stockroom-demo
```

腳本從指定提交透過 `git archive` 建置 `stockroom-drill:1bec991`，再把映像載入新叢集。每次執行使用獨立名稱和暫存 kubeconfig，結束時會移除這次建立的叢集及其中的資料。本機 Docker 會保留建置完成的應用程式映像，方便下次執行。[應用程式版本](https://github.com/peca12968/hey-table/tree/1bec99199cf0ee8ed9d9b3d34ddbaad10dc01930) · [kind 使用說明](https://kind.sigs.k8s.io/docs/user/quick-start/)

| 階段 | 驗證條件 |
| --- | --- |
| 第一次保留 | 20 件中保留 7 件，HTTP 201，剩餘 13 件 |
| 滾動重啟 StatefulSet | 新 Pod 的 UID 已改變，掛載的 PVC UID 與 PV 名稱維持一致 |
| 重送原訂單 | HTTP 200，訂單 ID、數量、狀態與到期時間均與原回應一致，仍剩 13 件 |
| 解除保留 | HTTP 200，庫存回到 20 件 |

成功時標準輸出是一份 JSON，包含兩次 Pod 與儲存識別資料、HTTP 狀態和庫存。GitHub Actions 會將 JSON 放在該次執行摘要。若檢查失敗，腳本會輸出 Pod、PVC、事件與應用程式日誌，再結束演練。[演練流程](drill.py) · [HTTP 驗證](probe.py)

## 部署設計

- 一個 StatefulSet 副本執行 FastAPI，每個訂單操作在同一個 SQLite 資料庫裡完成。資料庫和 WAL 都位於 `/app/data` 的持久卷。StatefulSet 重建同一序號的 Pod 時會沿用該序號的儲存宣告。[部署清單](deploy.yaml) · [Kubernetes StatefulSet 文件](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- Headless Service 提供 StatefulSet 的網路識別，呼叫端透過另一個 ClusterIP Service 存取 API。readiness probe 查詢 `/inventory`，資料庫可完成庫存操作時才接收流量。
- 驗證範圍是同一節點上的 Pod 更換，單副本在更換期間會短暫中斷。整個節點或磁碟遺失時，復原需要獨立保存的備份。另一個作品提供對應的還原演練。[SQLite Recovery Drill](https://github.com/peca12968/sqlite-recovery-drill)

**履歷用語**　以 Kubernetes StatefulSet 與持久卷部署庫存 API，透過 CI 建立臨時叢集並實際重建 Pod，從 HTTP 訂單重送、庫存與磁碟識別資料驗證重啟後的一致性。

本作品使用 AI 輔助開發，庫存數字來自合成訂單。
