"""Minimal CORS middleware for the local workspace server (no dependency).

The Sard SPA runs on the Vite dev/preview server (localhost:5173 / 4173)
and calls this API on localhost:8000, so the browser sends cross-origin
requests even though everything is on one machine. Only the origins listed
in `CORS_ALLOWED_ORIGINS` are accepted; the default covers local Vite ports
and nothing else.
"""

from django.conf import settings
from django.http import HttpResponse


class LocalCorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def _apply(self, response, origin):
        response["Access-Control-Allow-Origin"] = origin
        response["Vary"] = "Origin"
        response["Access-Control-Allow-Headers"] = "authorization, content-type"
        response["Access-Control-Allow-Methods"] = "GET, POST, PATCH, PUT, DELETE, OPTIONS"
        response["Access-Control-Max-Age"] = "86400"
        return response

    def __call__(self, request):
        origin = request.headers.get("Origin", "")
        allowed = origin in settings.CORS_ALLOWED_ORIGINS
        if request.method == "OPTIONS" and allowed:
            return self._apply(HttpResponse(status=204), origin)
        response = self.get_response(request)
        if allowed:
            self._apply(response, origin)
        return response
