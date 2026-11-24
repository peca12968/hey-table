# 禾日食堂｜系統模組

首頁的 [點餐與店員操作說明](../README.md) 包含網站啟動方式。此目錄收錄同一系統的營運與倉庫工具。各模組說明的指令從該模組目錄執行。

| 流程 | 使用方式與模組 |
| --- | --- |
| 點餐與 QR | 前台載入[套餐計價](combo-counter/README.md)、[餐點搭配](menu-pairs/README.md)、[收據分帳](table-shares/README.md)與[取餐估算](pickup-window/README.md)。送印前可核對[桌牌 QR](table-scan-check/README.md)。 |
| 廚房備料與出餐 | 用接單台匯出進行[備料與驗收](prep-sheet/README.md)、[採購規劃](pantry-freight/README.md)及[分站出單](pass-rail/README.md)。以[工時紀錄](batch-clock/README.md)更新估算，並查[等候時間](ready-range/README.md)或匯出[自取預約](pickup-agenda/README.md)。 |
| 餐單退餐與食材 | 用已成交收據做[退餐試算](receipt-returns/README.md)與[逐菜食材成本](plate-cost/README.md)。班末以備料帳、進貨成本和盤點數量核對[報廢及短差](batch-waste/README.md)。 |
| 金流與現金交班 | [電子支付日結](payout-ledger/README.md)查請退款與銀行撥款，[無批號查核](remit-match/README.md)保留銀行查證依據，[付款時限](wallet-observer/README.md)分析重試。現場可[找零](till-change/README.md)、[盤點錢櫃](drawer-count/README.md)及[規劃備零](float-plan/README.md)。 |
| 倉庫出貨與退貨 | 先在[庫存服務](stockroom-reservations/README.md)保留商品，從同一快照做[到期前出貨安排](dispatch-window/README.md)，再依驗收批號取得收據並製作[簽章交接檔](return-docket/README.md)。 |

## 驗證整個系統

在儲存庫根目錄執行。操作模組需 Python 3.12、Node.js 24 和 .NET 10 SDK。Windows 上如要額外驗證獨立簽章相容性，可讓測試程序的 PATH 找到 OpenSSL。

```sh
npm ci --include=optional
npm ci --prefix modules/pickup-agenda
python -m pip install -r modules/stockroom-reservations/requirements-dev.txt -r modules/pickup-agenda/requirements.txt
python scripts/verify-operations.py operations
```

```sh
python -m pip install -r modules/float-plan/requirements.txt
python scripts/verify-operations.py cashier
```

中央 CI 亦在 Chromium 驗證手機點餐、示範付款、店員接單與桌牌 PDF。所有測試使用合成資料及本機服務。[共同驗證流程](../.github/workflows/test.yml)

## 同庫模組

- [body-replay](body-replay/README.md)
- [commit-gap](commit-gap/README.md)
- [hold-model](hold-model/README.md)
- [stockroom-k8s-drill](stockroom-k8s-drill/README.md)
- [sqlite-recovery-drill](sqlite-recovery-drill/README.md)
- [shift-vault](shift-vault/README.md)
- [wal-lantern](wal-lantern/README.md)
- [dock-outbox](dock-outbox/README.md)
- [manifest-intake](manifest-intake/README.md)
- [proto-relay-probe](proto-relay-probe/README.md)
- [burn-pair](burn-pair/README.md)
- [warehouse-pick-route](warehouse-pick-route/README.md)
- [coldroom-inbox](coldroom-inbox/README.md)
- [count-relay](count-relay/README.md)｜離線盤點、複點與 Stockroom 實物庫存核對
- [bay-signal](bay-signal/README.md)
- [delivery-archive](delivery-archive/README.md)
- [parcel-event-windows](parcel-event-windows/README.md)
- [track-thinner](track-thinner/README.md)
- [shelf-backtest](shelf-backtest/README.md)

[整合驗證](../.github/workflows/system.yml)
