from contextlib import asynccontextmanager
import csv
from io import StringIO
from pathlib import Path
import os
import time
from typing import Annotated, Literal

from fastapi import FastAPI, Header, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
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


class ReservationBatchReceipt(BaseModel):
    batch_id: str
    expires_at_ms: int
    items: list[ReservedItem]


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


class ReturnReceipt(BaseModel):
    reservation_id: str
    shipment_id: str
    return_id: str
    quantity: int
    returnable_after: int


class ReturnBatchReceipt(BaseModel):
    batch_id: str
    boxes: list[ReturnReceipt]


class PackingStatement(BaseModel):
    reservation: Progress
    boxes: list[ShipmentBalance]
    restocked: int
    returnable: int


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

    @app.post("/dispatch-batches", response_model=BatchReceipt, status_code=201,
              responses={200: {"model": BatchReceipt, "description": "Original dispatch batch receipt"}})
    def dispatch_batch(batch: DispatchBatch, response: Response, idempotency_key: RequestKey):
        boxes = [(box.reservation_id, box.shipment_id, box.quantity) for box in batch.boxes]
        receipt, created = store.dispatch_batch(idempotency_key, boxes)
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

    @app.get("/reservations/{key}/fulfillments", response_model=PackingStatement)
    def packing_statement(key: str):
        return store.packing_statement(key)

    @app.post("/packing-snapshots", response_model=PackingSnapshot)
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

    @app.get("/reservations/{key}/fulfillments/{shipment_id}", response_model=ShipmentBalance)
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
