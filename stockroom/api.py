from contextlib import asynccontextmanager
from pathlib import Path
import os
import time
from typing import Annotated

from fastapi import FastAPI, Header, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .store import Conflict, Missing, Store


class Order(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sku: str = Field(min_length=1, max_length=80)
    quantity: int = Field(strict=True, ge=1, le=1_000_000)


class Reservation(Order):
    id: str
    state: str
    expires_at_ms: int | None


class Product(BaseModel):
    sku: str
    capacity: int
    available: int


def create_app(path: Path, *, ttl_seconds=900, clock=time.time):
    store = Store(path, ttl_seconds=ttl_seconds, clock=clock)

    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        yield

    app = FastAPI(title="Stockroom Reservations", version="1.1", lifespan=lifespan)

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
                idempotency_key: Annotated[str, Header(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]):
        result, created = store.reserve(idempotency_key, order.sku, order.quantity)
        if not created:
            response.status_code = 200
        return result

    @app.delete("/reservations/{key}", response_model=Reservation)
    def release(key: str):
        return store.release(key)

    return app


app = create_app(Path(os.environ.get("STOCKROOM_DB", "data/stockroom.db")),
                 ttl_seconds=int(os.environ.get("STOCKROOM_TTL_SECONDS", "900")))
