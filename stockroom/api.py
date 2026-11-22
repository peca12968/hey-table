from contextlib import asynccontextmanager
from pathlib import Path
import os
import time
from typing import Annotated

from fastapi import FastAPI, Header, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

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


class Product(BaseModel):
    sku: str
    capacity: int
    available: int


class Progress(Reservation):
    shipped: int
    held: int
    returned: int


class Receipt(BaseModel):
    reservation_id: str
    shipment_id: str
    quantity: int
    held_after: int


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


class ReleaseReceipt(BaseModel):
    reservation_id: str
    release_id: str
    quantity: int
    held_after: int


RequestKey = Annotated[str, Header(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]


def create_app(path: Path, *, ttl_seconds=900, clock=time.time):
    store = Store(path, ttl_seconds=ttl_seconds, clock=clock)

    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        yield

    app = FastAPI(title="Stockroom Reservations", version="1.4", lifespan=lifespan)

    @app.exception_handler(Missing)
    async def missing(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.get("/inventory", response_model=list[Product])
    def inventory():
        return store.inventory()

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

    @app.post("/reservations/{key}/releases", response_model=ReleaseReceipt, status_code=201,
              responses={200: {"model": ReleaseReceipt, "description": "Original release receipt"}})
    def release_units(key: str, reduction: Quantity, response: Response, idempotency_key: RequestKey):
        receipt, created = store.release_units(key, idempotency_key, reduction.quantity)
        if not created:
            response.status_code = 200
        return receipt

    @app.get("/reservations/{key}", response_model=Progress)
    def progress(key: str):
        return store.progress(key)

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
