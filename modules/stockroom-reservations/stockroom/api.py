from contextlib import asynccontextmanager
import csv
from io import StringIO
from pathlib import Path
import os
import time
from typing import Annotated, Literal

from fastapi import FastAPI, Header, HTTPException, Query, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from prometheus_client import CollectorRegistry, Counter, generate_latest, CONTENT_TYPE_LATEST

from .metrics import RequestMetrics
from .store import Conflict, Missing, Store


class Quantity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quantity: int = Field(strict=True, ge=1, le=1_000_000)


class Order(Quantity):
    sku: str = Field(min_length=1, max_length=80)


class Reservation(Order):
    id: str
    state: str
    expires_at_ms: int | None


class ReservationBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Order] = Field(min_length=1, max_length=100)

    @field_validator("items")
    @classmethod
    def distinct_products(cls, items):
        if len({item.sku for item in items}) != len(items):
            raise ValueError("Repeat SKU in reservation batch")
        return items


class ReservedItem(Order):
    id: str


class ReplacementReservation(BaseModel):
    id: str
    sku: str
    quantity: int
    expires_at_ms: int


class ReplacementReceipt(BaseModel):
    source_id: str
    created_at_ms: int
    reservation: ReplacementReservation


class ReservationBatchReceipt(BaseModel):
    batch_id: str
    expires_at_ms: int
    items: list[ReservedItem]


class ReplacedBatchItem(ReservedItem):
    source_id: str


class BatchReplacementReceipt(ReservationBatchReceipt):
    source_batch_id: str
    created_at_ms: int
    items: list[ReplacedBatchItem]


class ReplacementPreviewItem(BaseModel):
    source_id: str
    sku: str
    expired_quantity: int
    available: int
    shortfall: int
    status: Literal["active", "replaced", "closed", "shortage", "ready"]
    replacement_id: str | None


class BatchReplacementPreview(BaseModel):
    source_batch_id: str
    captured_at_ms: int
    status: Literal["cancelled", "active", "none_expired", "item_replaced", "shortage", "ready", "replaced"]
    replacement_batch_id: str | None
    items: list[ReplacementPreviewItem]


class CancelledBatchItem(BaseModel):
    id: str
    sku: str
    quantity_released: int


class BatchCancellationReceipt(BaseModel):
    batch_id: str
    cancelled_at_ms: int
    items: list[CancelledBatchItem]


class Product(BaseModel):
    sku: str
    capacity: int
    available: int


class InventorySnapshot(BaseModel):
    captured_at_ms: int
    products: list[Product]


class AllocationLine(BaseModel):
    reservation_id: str
    batch_id: str | None
    expires_at_ms: int | None
    quantity: int
    shipped: int
    released: int
    held: int


class AllocationSummary(BaseModel):
    reservation_count: int
    held: int
    without_deadline_count: int
    without_deadline_held: int
    next_expiry_at_ms: int | None


class SKUAllocations(BaseModel):
    captured_at_ms: int
    product: Product
    summary: AllocationSummary
    reservations: list[AllocationLine]
    next_after_id: str | None


class StockCountBasisProduct(Product):
    held: int
    revision: int


class StockCountBasis(StockCountBasisProduct):
    captured_at_ms: int


StockCountSKU = Annotated[str, Field(min_length=1, max_length=80)]


class StockCountBasisScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skus: list[StockCountSKU] = Field(min_length=1, max_length=100)

    @field_validator("skus")
    @classmethod
    def distinct_skus(cls, skus):
        if len(skus) != len(set(skus)):
            raise ValueError("Repeat SKU in stock count basis")
        return skus


class StockCountBasisBatch(BaseModel):
    captured_at_ms: int
    products: list[StockCountBasisProduct]


class StockCountValue(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(strict=True, ge=0, le=2**63 - 1)
    counted: int = Field(strict=True, ge=0, le=2**63 - 1)


class StockCountReason(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)]


class StockCountMetadata(StockCountReason):
    count_session: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class StockCountAdjustment(StockCountMetadata, StockCountValue):
    pass


class StockCountLine(StockCountValue):
    sku: StockCountSKU


class StockCountBatch(StockCountMetadata):
    items: list[StockCountLine] = Field(min_length=1, max_length=100)

    @field_validator("items")
    @classmethod
    def distinct_skus(cls, items):
        if len(items) != len({item.sku for item in items}):
            raise ValueError("Repeat SKU in stock count batch")
        return items


class StockCountReceipt(BaseModel):
    id: str
    sku: str
    count_session: str
    reason: str
    recorded_at_ms: int
    previous_revision: int
    previous_capacity: int
    previous_available: int
    counted: int
    available: int
    revision: int


class StockCountBatchReceipt(BaseModel):
    batch_id: str
    items: list[StockCountReceipt]


class StockCountBatchReversal(StockCountBatchReceipt):
    source_batch_id: str


class ExpiringReservation(BaseModel):
    reservation_id: str
    sku: str
    expires_at_ms: int
    shipped: int
    held: int
    batch_id: str | None


class ExpiryCursor(BaseModel):
    through_ms: int
    after_expires_at_ms: int
    after_id: str


class ExpiryQueue(BaseModel):
    captured_at_ms: int
    through_ms: int
    reservations: list[ExpiringReservation]
    next: ExpiryCursor | None


class ReclaimedReservation(BaseModel):
    reservation_id: str
    sku: str
    batch_id: str | None
    expires_at_ms: int
    reclaimed_at_ms: int | None
    quantity: int
    shipped: int
    released_before_expiry: int
    reclaimed: int


class ExpiryHistoryCursor(BaseModel):
    through_ms: int
    before_expires_at_ms: int
    before_id: str


class ExpiryHistory(BaseModel):
    captured_at_ms: int
    since_ms: int
    through_ms: int
    reservations: list[ReclaimedReservation]
    next: ExpiryHistoryCursor | None


class Progress(Reservation):
    shipped: int
    held: int
    returned: int


class ReservationBatchStatus(InventorySnapshot):
    batch_id: str
    initial_expires_at_ms: int
    cancelled_at_ms: int | None
    items: list[Progress]


class Receipt(BaseModel):
    reservation_id: str
    shipment_id: str
    quantity: int
    held_after: int


BoxKey = Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]


class DispatchBox(Quantity):
    reservation_id: BoxKey
    shipment_id: BoxKey


class DispatchBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    boxes: list[DispatchBox] = Field(min_length=1, max_length=100)

    @field_validator("boxes")
    @classmethod
    def distinct_boxes(cls, boxes):
        if len({(box.reservation_id, box.shipment_id) for box in boxes}) != len(boxes):
            raise ValueError("Repeat shipment within a reservation")
        return boxes

    def shipment_requests(self):
        return [(box.reservation_id, box.shipment_id, box.quantity) for box in self.boxes]


class DispatchWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    not_before_ms: int = Field(strict=True, ge=0, le=2**53 - 1)
    before_ms: int = Field(strict=True, ge=1, le=2**53 - 1)

    @model_validator(mode="after")
    def ordered_bounds(self):
        if self.before_ms <= self.not_before_ms:
            raise ValueError("before_ms must follow not_before_ms")
        return self


class ScheduledDispatchBatch(DispatchBatch):
    window: DispatchWindow | None = None


class DispatchPreviewBox(BaseModel):
    reservation_id: str
    shipment_id: str
    quantity: int
    sku: str | None
    reservation_state: Literal["held", "released", "expired", "fulfilled"] | None
    held_before: int | None
    held_after: int | None
    shortfall: int | None
    status: Literal["ready", "unknown_reservation", "already_shipped", "insufficient_held"]


class DispatchPreview(BaseModel):
    captured_at_ms: int
    can_dispatch: bool
    boxes: list[DispatchPreviewBox]


class BatchReceipt(BaseModel):
    batch_id: str
    boxes: list[Receipt]


class ShipmentBalance(BaseModel):
    reservation_id: str
    shipment_id: str
    sku: str
    dispatched: int
    restocked: int
    returnable: int
    quarantined: int = 0
    discarded: int = 0


class ReturnReceipt(BaseModel):
    reservation_id: str
    shipment_id: str
    return_id: str
    quantity: int
    returnable_after: int


class ReturnBatchReceipt(BaseModel):
    batch_id: str
    boxes: list[ReturnReceipt]


class ReturnInspectionBox(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reservation_id: BoxKey
    shipment_id: BoxKey
    sellable: int = Field(strict=True, ge=0, le=1_000_000)
    quarantined: int = Field(strict=True, ge=0, le=1_000_000)

    @model_validator(mode="after")
    def quantities(self):
        if not 1 <= self.sellable + self.quarantined <= 1_000_000:
            raise ValueError("Inspect between 1 and 1000000 units per shipment")
        return self


class ReturnInspectionBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    boxes: list[ReturnInspectionBox] = Field(min_length=1, max_length=100)

    @field_validator("boxes")
    @classmethod
    def distinct_boxes(cls, boxes):
        return DispatchBatch.distinct_boxes(boxes)


class ReturnInspectedBox(ReturnInspectionBox):
    returnable_after: int


class ReturnInspectionReceipt(BaseModel):
    batch_id: str
    boxes: list[ReturnInspectedBox]


class QuarantineStatusBox(BaseModel):
    reservation_id: BoxKey
    shipment_id: BoxKey
    sku: str
    quarantined: int
    restocked: int
    discarded: int
    remaining: int


class QuarantineStatus(BaseModel):
    batch_id: str
    boxes: list[QuarantineStatusBox]


class QuarantineDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reservation_id: BoxKey
    shipment_id: BoxKey
    restock: int = Field(strict=True, ge=0, le=1_000_000)
    discard: int = Field(strict=True, ge=0, le=1_000_000)
    expected_remaining: int = Field(strict=True, ge=1, le=1_000_000)
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]

    @model_validator(mode="after")
    def quantities(self):
        if not 1 <= self.restock + self.discard <= self.expected_remaining:
            raise ValueError("Disposition must use a positive quantity within the reviewed balance")
        return self


class QuarantineDisposition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    boxes: list[QuarantineDecision] = Field(min_length=1, max_length=100)

    @field_validator("boxes")
    @classmethod
    def distinct_boxes(cls, boxes):
        return DispatchBatch.distinct_boxes(boxes)


class QuarantineDispositionBox(BaseModel):
    reservation_id: BoxKey
    shipment_id: BoxKey
    restock: int
    discard: int
    reason: str
    remaining_after: int
    recorded_at_ms: int


class QuarantineDispositionReceipt(BaseModel):
    batch_id: str
    disposition_id: str
    boxes: list[QuarantineDispositionBox]


class PackingStatement(BaseModel):
    reservation: Progress
    boxes: list[ShipmentBalance]
    restocked: int
    returnable: int
    quarantined: int = 0
    discarded: int = 0


class PackingScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reservation_ids: list[BoxKey] = Field(min_length=1, max_length=100)

    @field_validator("reservation_ids")
    @classmethod
    def distinct_reservations(cls, keys):
        if len(keys) != len(set(keys)):
            raise ValueError("Repeat reservation ID")
        return keys


class PackingSnapshot(BaseModel):
    captured_at_ms: int
    holds: list[PackingStatement]
    products: list[Product]


class ReleaseReceipt(BaseModel):
    reservation_id: str
    release_id: str
    quantity: int
    held_after: int


class ReleaseBatchItem(Quantity):
    reservation_id: BoxKey
    expected_held: int = Field(strict=True, ge=1, le=2**63 - 1)


class ReleaseBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ReleaseBatchItem] = Field(min_length=1, max_length=100)

    @field_validator("items")
    @classmethod
    def distinct_reservations(cls, items):
        if len({item.reservation_id for item in items}) != len(items):
            raise ValueError("Repeat reservation in release batch")
        return items


class ReleasedBatchItem(BaseModel):
    reservation_id: str
    held_before: int
    quantity: int
    held_after: int


class ReleaseBatchReceipt(BaseModel):
    batch_id: str
    released_at_ms: int
    items: list[ReleasedBatchItem]


class ReleaseHistoryItem(BaseModel):
    source: Literal["single", "batch"]
    receipt_id: str
    released_at_ms: int | None
    held_before: int
    quantity: int
    held_after: int


class ReleaseHistory(BaseModel):
    captured_at_ms: int
    reservation: Progress
    releases: list[ReleaseHistoryItem]
    next_after_held: int | None


ExpectedDeadline = Annotated[int, Field(strict=True, ge=0, le=2**63 - 1)]
ExtensionSeconds = Annotated[int, Field(strict=True, ge=1, le=86_400)]


class Renewal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_expires_at_ms: ExpectedDeadline
    extend_seconds: ExtensionSeconds


class RenewalReceipt(BaseModel):
    reservation_id: str
    renewal_id: str
    previous_expires_at_ms: int
    expires_at_ms: int


class RenewalHistoryItem(BaseModel):
    source: Literal["single", "batch"]
    receipt_id: str
    previous_expires_at_ms: int
    expires_at_ms: int


class RenewalHistory(BaseModel):
    reservation: Progress
    renewals: list[RenewalHistoryItem]
    next_before_expires_at_ms: int | None


class RenewalBatchItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reservation_id: BoxKey
    expected_expires_at_ms: ExpectedDeadline


class RenewalBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    extend_seconds: ExtensionSeconds
    items: list[RenewalBatchItem] = Field(min_length=1, max_length=100)

    @field_validator("items")
    @classmethod
    def distinct_reservations(cls, items):
        if len({item.reservation_id for item in items}) != len(items):
            raise ValueError("Repeat reservation in renewal batch")
        return items


class RenewedBatchItem(BaseModel):
    reservation_id: str
    previous_expires_at_ms: int
    expires_at_ms: int


class RenewalBatchReceipt(BaseModel):
    batch_id: str
    items: list[RenewedBatchItem]


RequestKey = Annotated[str, Header(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]


def create_app(path: Path, *, ttl_seconds=900, clock=time.time):
    store = Store(path, ttl_seconds=ttl_seconds, clock=clock)

    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        yield

    app = FastAPI(title="Stockroom Reservations", version="1.7", lifespan=lifespan)
    workbench = Path(__file__).resolve().parent / "workbench"

    @app.get("/workbench/assets/{name}", include_in_schema=False)
    def workbench_asset(name: str):
        media_type = {
            "dispatch.mjs": "text/javascript",
            "quarantine.mjs": "text/javascript",
            "replacement.mjs": "text/javascript",
            "quarantine.css": "text/css",
            "workbench.css": "text/css",
        }.get(name)
        if media_type is None:
            raise HTTPException(status_code=404)
        filename = "workbench.css" if name == "quarantine.css" else name
        return FileResponse(workbench / "assets" / filename, media_type=media_type,
                            headers={"X-Content-Type-Options": "nosniff"})

    @app.get("/workbench/{tool_name}", include_in_schema=False)
    def workbench_page(tool_name: str):
        if tool_name not in ("dispatch", "quarantine", "replacement"):
            raise HTTPException(status_code=404)
        return FileResponse(workbench / (tool_name + ".html"), media_type="text/html", headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        })
    registry = CollectorRegistry()
    requests = Counter("http_requests_total", "Application requests by HTTP response status.", ["status"], registry=registry)
    for status in ("200", "201", "404", "409", "422", "500"):
        requests.labels(status)
    app.add_middleware(RequestMetrics, counter=requests)

    @app.get("/metrics", include_in_schema=False)
    def metrics():
        return Response(generate_latest(registry), headers={"Content-Type": CONTENT_TYPE_LATEST})

    @app.exception_handler(Missing)
    async def missing(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.get("/inventory", response_model=list[Product])
    def inventory():
        return store.inventory()

    @app.get("/inventory-snapshot", response_model=InventorySnapshot)
    def inventory_snapshot(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.inventory_snapshot()

    @app.get("/inventory/{sku}/allocations", response_model=SKUAllocations)
    def sku_allocations(
        sku: str,
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        after_id: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    ):
        response.headers["Cache-Control"] = "no-store"
        return store.sku_allocations(sku, limit, after_id)

    @app.get("/inventory/{sku}/count-basis", response_model=StockCountBasis)
    def stock_count_basis(sku: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.stock_count_basis(sku)

    @app.post("/inventory/{sku}/count-adjustments", response_model=StockCountReceipt, status_code=201,
              responses={200: {"model": StockCountReceipt, "description": "Original stock count receipt"}})
    def adjust_stock_count(sku: str, adjustment: StockCountAdjustment, response: Response, idempotency_key: RequestKey):
        receipt, created = store.adjust_stock_count(sku, idempotency_key, adjustment.expected_revision,
                                                   adjustment.counted, adjustment.count_session, adjustment.reason)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/inventory/{sku}/count-adjustments/{adjustment_id}", response_model=StockCountReceipt)
    def stock_count_receipt(sku: str, adjustment_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.stock_count_adjustment(sku, adjustment_id)

    @app.post("/stock-count-basis", response_model=StockCountBasisBatch)
    def stock_count_bases(scope: StockCountBasisScope, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.stock_count_bases(scope.skus)

    @app.post("/stock-count-batches", response_model=StockCountBatchReceipt, status_code=201,
              responses={200: {"model": StockCountBatchReceipt, "description": "Original stock count batch receipt"}})
    def adjust_stock_count_batch(batch: StockCountBatch, response: Response, idempotency_key: RequestKey):
        items = [(item.sku, item.expected_revision, item.counted) for item in batch.items]
        receipt, created = store.adjust_stock_count_batch(idempotency_key, items, batch.count_session, batch.reason)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/stock-count-batches/{batch_id}", response_model=StockCountBatchReceipt)
    def stock_count_batch_receipt(batch_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.stock_count_batch(batch_id)

    @app.post("/stock-count-batches/{batch_id}/reversal", response_model=StockCountBatchReversal, status_code=201,
              responses={200: {"model": StockCountBatchReversal, "description": "Original stock count batch reversal"}})
    def reverse_stock_count_batch(batch_id: BoxKey, correction: StockCountReason, response: Response, idempotency_key: RequestKey):
        receipt, created = store.reverse_stock_count_batch(batch_id, idempotency_key, correction.reason)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/stock-count-batches/{batch_id}/reversal", response_model=StockCountBatchReversal)
    def stock_count_reversal_receipt(batch_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.stock_count_batch_reversal(batch_id)

    @app.get("/expiring-reservations", response_model=ExpiryQueue)
    def expiring_reservations(
        response: Response,
        within_seconds: Annotated[int, Query(ge=1, le=86_400)] = 900,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        sku: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
        through_ms: Annotated[int | None, Query(ge=0, le=2**63 - 1)] = None,
        after_expires_at_ms: Annotated[int | None, Query(ge=0, le=2**63 - 1)] = None,
        after_id: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    ):
        if after_expires_at_ms is not None or after_id is not None:
            if through_ms is None or after_id is None or after_expires_at_ms is None or after_expires_at_ms > through_ms:
                raise HTTPException(422, "Supply a complete deadline cursor")
        try:
            result = store.expiring_reservations(within_seconds, limit, sku, through_ms, (after_expires_at_ms, after_id))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        response.headers["Cache-Control"] = "no-store"
        return result

    @app.get("/expired-reservations", response_model=ExpiryHistory)
    def expiry_history(
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        sku: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
        since_ms: Annotated[int, Query(ge=0, le=2**63 - 1)] = 0,
        through_ms: Annotated[int | None, Query(ge=0, le=2**63 - 1)] = None,
        before_expires_at_ms: Annotated[int | None, Query(ge=0, le=2**63 - 1)] = None,
        before_id: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    ):
        if before_expires_at_ms is not None or before_id is not None:
            if (through_ms is None or before_id is None or before_expires_at_ms is None
                    or not since_ms <= before_expires_at_ms <= through_ms):
                raise HTTPException(422, "Supply a complete expiry history cursor")
        try:
            result = store.expiry_history(since_ms, through_ms, sku, (before_expires_at_ms, before_id), limit)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        response.headers["Cache-Control"] = "no-store"
        return result

    @app.post("/dispatch-batches/preview", response_model=DispatchPreview)
    def dispatch_preview(batch: DispatchBatch, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.dispatch_preview(batch.shipment_requests())

    @app.post("/dispatch-batches", response_model=BatchReceipt, status_code=201,
              responses={200: {"model": BatchReceipt, "description": "Original dispatch batch receipt"}})
    def dispatch_batch(batch: ScheduledDispatchBatch, response: Response, idempotency_key: RequestKey):
        window = (batch.window.not_before_ms, batch.window.before_ms) if batch.window else None
        receipt, created = store.dispatch_batch(idempotency_key, batch.shipment_requests(), window=window)
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/dispatch-batches/{batch_id}", response_model=BatchReceipt)
    def dispatch_batch_receipt(batch_id: str):
        return store.dispatch_batch_receipt(batch_id)

    @app.post("/renewal-batches", response_model=RenewalBatchReceipt, status_code=201,
              responses={200: {"model": RenewalBatchReceipt, "description": "Original renewal batch receipt"}})
    def renew_batch(batch: RenewalBatch, response: Response, idempotency_key: RequestKey):
        items = [(item.reservation_id, item.expected_expires_at_ms) for item in batch.items]
        receipt, created = store.renew_batch(idempotency_key, items, batch.extend_seconds)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/renewal-batches/{batch_id}", response_model=RenewalBatchReceipt)
    def renewal_batch_receipt(batch_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.renewal_batch_receipt(batch_id)

    @app.post("/release-batches", response_model=ReleaseBatchReceipt, status_code=201,
              responses={200: {"model": ReleaseBatchReceipt, "description": "Original release batch receipt"}})
    def release_batch(batch: ReleaseBatch, response: Response, idempotency_key: RequestKey):
        items = [(item.reservation_id, item.expected_held, item.quantity) for item in batch.items]
        receipt, created = store.release_batch(idempotency_key, items)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/release-batches/{batch_id}", response_model=ReleaseBatchReceipt)
    def release_batch_receipt(batch_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.release_batch_receipt(batch_id)

    @app.post("/return-batches", response_model=ReturnBatchReceipt, status_code=201,
              responses={200: {"model": ReturnBatchReceipt, "description": "Original return batch receipt"}})
    def return_batch(batch: DispatchBatch, response: Response, idempotency_key: RequestKey):
        boxes = [(box.reservation_id, box.shipment_id, box.quantity) for box in batch.boxes]
        receipt, created = store.return_batch(idempotency_key, boxes)
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/return-batches/{batch_id}", response_model=ReturnBatchReceipt)
    def return_batch_receipt(batch_id: str):
        return store.return_batch_receipt(batch_id)

    @app.post("/return-inspections", response_model=ReturnInspectionReceipt, status_code=201,
              responses={200: {"model": ReturnInspectionReceipt, "description": "Original return inspection receipt"}})
    def return_inspection(batch: ReturnInspectionBatch, response: Response, idempotency_key: RequestKey):
        boxes = [(box.reservation_id, box.shipment_id, box.sellable, box.quarantined) for box in batch.boxes]
        receipt, created = store.return_inspection(idempotency_key, boxes)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/return-inspections/{batch_id}", response_model=ReturnInspectionReceipt)
    def return_inspection_receipt(batch_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.return_inspection_receipt(batch_id)

    @app.get("/return-inspections/{batch_id}/quarantine", response_model=QuarantineStatus)
    def quarantine_status(batch_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.quarantine_status(batch_id)

    @app.post("/return-inspections/{batch_id}/dispositions", response_model=QuarantineDispositionReceipt, status_code=201,
              responses={200: {"model": QuarantineDispositionReceipt, "description": "Original disposition receipt"}})
    def dispose_quarantine(batch_id: BoxKey, decision: QuarantineDisposition, response: Response, idempotency_key: RequestKey):
        boxes = [(box.reservation_id, box.shipment_id, box.restock, box.discard, box.expected_remaining, box.reason)
                 for box in decision.boxes]
        receipt, created = store.dispose_quarantine(batch_id, idempotency_key, boxes)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/return-inspections/{batch_id}/dispositions/{disposition_id}", response_model=QuarantineDispositionReceipt)
    def quarantine_receipt(batch_id: BoxKey, disposition_id: BoxKey, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.quarantine_receipt(batch_id, disposition_id)

    @app.post("/reservation-batches", response_model=ReservationBatchReceipt, status_code=201,
              responses={200: {"model": ReservationBatchReceipt, "description": "Original reservation batch receipt"}})
    def reserve_batch(batch: ReservationBatch, response: Response, idempotency_key: RequestKey):
        receipt, created = store.reserve_batch(idempotency_key, [(item.sku, item.quantity) for item in batch.items])
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/reservation-batches/{batch_id}", response_model=ReservationBatchReceipt)
    def reservation_batch_receipt(batch_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.reservation_batch_receipt(batch_id)

    @app.get("/reservation-batches/{batch_id}/status", response_model=ReservationBatchStatus)
    def reservation_batch_status(batch_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.reservation_batch_status(batch_id)

    @app.delete("/reservation-batches/{batch_id}", response_model=BatchCancellationReceipt)
    def cancel_batch(batch_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.cancel_batch(batch_id)

    @app.get("/reservation-batches/{batch_id}/cancellation", response_model=BatchCancellationReceipt)
    def batch_cancellation_receipt(batch_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.batch_cancellation_receipt(batch_id)

    @app.post("/reservation-batches/{batch_id}/replacement", response_model=BatchReplacementReceipt, status_code=201,
              responses={200: {"model": BatchReplacementReceipt, "description": "Original batch replacement receipt"}})
    def replace_expired_batch(batch_id: str, response: Response, idempotency_key: RequestKey):
        receipt, created = store.replace_expired_batch(batch_id, idempotency_key)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/reservation-batches/{batch_id}/replacement", response_model=BatchReplacementReceipt)
    def batch_replacement_receipt(batch_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.get_batch_replacement(batch_id)

    @app.get("/reservation-batches/{batch_id}/replacement-preview", response_model=BatchReplacementPreview)
    def batch_replacement_preview(batch_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.batch_replacement_preview(batch_id)

    @app.post("/reservations", response_model=Reservation, status_code=201,
              responses={200: {"model": Reservation, "description": "Idempotent replay"}})
    def reserve(order: Order, response: Response,
                idempotency_key: RequestKey):
        result, created = store.reserve(idempotency_key, order.sku, order.quantity)
        if not created:
            response.status_code = 200
        return result

    @app.delete("/reservations/{key}", response_model=Reservation)
    def release(key: str):
        return store.release(key)

    @app.post("/reservations/{key}/replacement", response_model=ReplacementReceipt, status_code=201,
              responses={200: {"model": ReplacementReceipt, "description": "Original replacement receipt"}})
    def replace_expired(key: str, response: Response, idempotency_key: RequestKey):
        receipt, created = store.replace_expired(key, idempotency_key)
        response.headers["Cache-Control"] = "no-store"
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/reservations/{key}/replacement", response_model=ReplacementReceipt)
    def replacement_receipt(key: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.get_replacement(key)

    @app.post("/reservations/{key}/renewals", response_model=RenewalReceipt, status_code=201,
              responses={200: {"model": RenewalReceipt, "description": "Original renewal receipt"}})
    def renew(key: str, renewal: Renewal, response: Response, idempotency_key: RequestKey):
        receipt, created = store.renew(key, idempotency_key, renewal.expected_expires_at_ms, renewal.extend_seconds)
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/reservations/{key}/renewals", response_model=RenewalHistory)
    def renewal_history(key: str, response: Response,
                        limit: Annotated[int, Query(ge=1, le=100)] = 25,
                        before_expires_at_ms: Annotated[int | None, Query(ge=0, le=2**63 - 1)] = None):
        response.headers["Cache-Control"] = "no-store"
        return store.renewal_history(key, limit, before_expires_at_ms)

    @app.post("/reservations/{key}/releases", response_model=ReleaseReceipt, status_code=201,
              responses={200: {"model": ReleaseReceipt, "description": "Original release receipt"}})
    def release_units(key: str, reduction: Quantity, response: Response, idempotency_key: RequestKey):
        receipt, created = store.release_units(key, idempotency_key, reduction.quantity)
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/reservations/{key}/releases", response_model=ReleaseHistory)
    def release_history(key: str, response: Response,
                        limit: Annotated[int, Query(ge=1, le=100)] = 25,
                        after_held: Annotated[int | None, Query(ge=0, le=2**63 - 1)] = None):
        response.headers["Cache-Control"] = "no-store"
        return store.release_history(key, limit, after_held)

    @app.get("/reservations/{key}", response_model=Progress)
    def progress(key: str):
        return store.progress(key)

    @app.get("/reservations/{key}/fulfillments", response_model=PackingStatement, response_model_exclude_unset=True)
    def packing_statement(key: str):
        return store.packing_statement(key)

    @app.post("/packing-snapshots", response_model=PackingSnapshot, response_model_exclude_unset=True)
    def packing_snapshot(scope: PackingScope, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.packing_snapshot(scope.reservation_ids)

    @app.get("/reservations/{key}/dispatch-manifest.csv", response_class=Response, responses={
        200: {"content": {"text/csv": {"schema": {"type": "string"}}},
              "headers": {"X-Box-Count": {"schema": {"type": "integer"}, "description": "Number of dispatched boxes"}}},
        409: {"description": "Reservation still holds stock or has no dispatched boxes"},
    })
    def dispatch_manifest(key: str):
        boxes = store.dispatch_manifest(key)
        output = StringIO(newline="")
        writer = csv.writer(output, lineterminator="\r\n")
        writer.writerow(("box_id", "units"))
        writer.writerows(boxes)
        return Response(output.getvalue(), media_type="text/csv", headers={
            "X-Box-Count": str(len(boxes)), "Content-Disposition": 'attachment; filename="dispatch-manifest.csv"'})

    @app.post("/reservations/{key}/fulfillments", response_model=Receipt, status_code=201,
              responses={200: {"model": Receipt, "description": "Original shipment receipt"}})
    def fulfill(key: str, shipment: Quantity, response: Response, idempotency_key: RequestKey):
        receipt, created = store.fulfill(key, idempotency_key, shipment.quantity)
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/reservations/{key}/fulfillments/{shipment_id}", response_model=ShipmentBalance, response_model_exclude_unset=True)
    def shipment(key: str, shipment_id: str):
        return store.shipment(key, shipment_id)

    @app.post("/reservations/{key}/fulfillments/{shipment_id}/returns", response_model=ReturnReceipt,
              status_code=201, responses={200: {"model": ReturnReceipt, "description": "Original return receipt"}})
    def restock(key: str, shipment_id: str, returned: Quantity, response: Response, idempotency_key: RequestKey):
        receipt, created = store.restock(key, shipment_id, idempotency_key, returned.quantity)
        if not created:
            response.status_code = 200
        return receipt

    return app


app = create_app(Path(os.environ.get("STOCKROOM_DB", "data/stockroom.db")),
                 ttl_seconds=int(os.environ.get("STOCKROOM_TTL_SECONDS", "900")))
