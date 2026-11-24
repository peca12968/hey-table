"""Run an isolated Stockroom child on a loopback socket and a caller-owned temporary DB."""
import os
import socket
import sys


def serve(checkout, database, now, boundary, channel):
    sys.path.insert(0, str(checkout))
    import uvicorn
    from stockroom import api

    if boundary == "before_commit":
        class TracedStore(api.Store):
            def connect(self):
                conn = super().connect()
                shipment_inserted = False

                def trace(sql):
                    nonlocal shipment_inserted
                    statement = sql.lstrip().upper()
                    if statement.startswith("INSERT INTO FULFILLMENTS("):
                        shipment_inserted = True
                    elif shipment_inserted and statement == "COMMIT":
                        os._exit(81)

                conn.set_trace_callback(trace)
                return conn

        api.Store = TracedStore
    app = api.create_app(database, ttl_seconds=10, clock=lambda: now)

    async def wrapped(scope, receive, send):
        async def send_before_headers(message):
            if (boundary == "before_reply" and scope.get("path") == "/reservations/order/fulfillments"
                    and message["type"] == "http.response.start" and message["status"] == 201):
                os._exit(82)
            await send(message)

        await app(scope, receive, send_before_headers)

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        channel.send(listener.getsockname()[1])
        channel.close()
        config = uvicorn.Config(wrapped, log_level="error", access_log=False, lifespan="on")
        uvicorn.Server(config).run(sockets=[listener])
