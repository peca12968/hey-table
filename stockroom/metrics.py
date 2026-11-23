"""Count HTTP response statuses per service process."""
from prometheus_client import Counter


class RequestMetrics:
    def __init__(self, app, *, counter: Counter):
        self.app = app
        self.counter = counter

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] == "/metrics":
            return await self.app(scope, receive, send)
        started = False

        async def observe(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                self.counter.labels(str(message["status"])).inc()
            await send(message)

        try:
            await self.app(scope, receive, observe)
        except Exception:
            # Starlette's outer ServerErrorMiddleware provides the 500 response.
            if not started:
                self.counter.labels("500").inc()
            raise
