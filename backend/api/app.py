from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.api import routes_platform, routes_projects, routes_stream
from backend.config import API_PREFIX, APP_VERSION, Config
from backend.orchestration.scheduler import SchedulerError
from backend.security.paths import PathViolation
from backend.security.policy import PermissionDenied

log = logging.getLogger("veylora.api")

OPEN_PATHS = {f"{API_PREFIX}/health"}


def create_app(config: Config | None = None, services=None) -> FastAPI:
    config = config or (services.config if services else Config.from_env())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        from backend.services import Services

        s = services or Services.build(config)
        app.state.services = s
        if config.start_scheduler_recovery:
            app.state.recovery = s.scheduler.recover()
        try:
            yield
        finally:
            await s.aclose()

    app = FastAPI(title="Veylora OS backend", version=APP_VERSION, lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=f"{API_PREFIX}/openapi.json")
    allowed_hosts = {f"127.0.0.1:{config.port}", f"localhost:{config.port}", "127.0.0.1", "localhost", "testserver"}
    expected = f"Bearer {config.session_token}"

    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = request.headers.get("host", "")
        if host not in allowed_hosts:
            return JSONResponse({"detail": "host not allowed"}, status_code=421)
        if request.method != "OPTIONS" and request.url.path not in OPEN_PATHS:
            supplied = request.headers.get("authorization", "")
            if not hmac.compare_digest(supplied.encode(), expected.encode()):
                return JSONResponse({"detail": "missing or invalid session token"}, status_code=401)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    app.add_middleware(CORSMiddleware, allow_origins=list(config.allowed_origins), allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                       allow_headers=["Authorization", "Content-Type", "Last-Event-ID"])

    @app.exception_handler(KeyError)
    async def not_found(_: Request, exc: KeyError):
        return JSONResponse({"detail": f"not found: {exc.args[0] if exc.args else ''}"}, status_code=404)

    @app.exception_handler(PermissionDenied)
    async def denied(_: Request, exc: PermissionDenied):
        return JSONResponse({"detail": str(exc)}, status_code=403)

    @app.exception_handler(PathViolation)
    async def bad_path(_: Request, exc: PathViolation):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(ValueError)
    async def bad_value(_: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(SchedulerError)
    async def conflict(_: Request, exc: SchedulerError):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.get(f"{API_PREFIX}/health")
    async def health():
        return {"status": "ok", "version": APP_VERSION}

    app.include_router(routes_projects.router, prefix=API_PREFIX)
    app.include_router(routes_platform.router, prefix=API_PREFIX)
    app.include_router(routes_stream.router, prefix=API_PREFIX)
    return app
