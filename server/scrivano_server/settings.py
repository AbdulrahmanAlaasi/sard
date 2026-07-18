"""Scrivano 2.0 backend settings.

Environment-driven: local development runs on SQLite out of the box; point
DATABASE_URL at Supabase (or any Postgres with pgvector) for the full stack.
See docs/MVP-PLAN.md for the complete environment variable reference.
"""

import os
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Local secrets live in server/.env (gitignored); production uses real env vars.
load_dotenv(BASE_DIR / ".env")

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-insecure-key")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "tenancy",
    "groups",
    "meetings",
    "intelligence",
    "chat",
    "memory",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "scrivano_server.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "scrivano_server.wsgi.application"

DATABASES = {
    "default": dj_database_url.config(
        default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}", conn_max_age=60
    )
}

AUTH_USER_MODEL = "tenancy.User"

REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "tenancy.authentication.SupabaseJWTAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {"anon": "60/hour", "user": "2000/hour", "upload": "60/hour"},
}

# Production hardening (ECC django-security checklist): everything below only
# activates when DEBUG is off, so local development stays friction-free.
if not DEBUG:
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    CSRF_COOKIE_SAMESITE = "Lax"
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = "DENY"
    if SECRET_KEY == "dev-only-insecure-key":
        raise RuntimeError("DJANGO_SECRET_KEY must be set in production.")

# Document uploads (spec §5 step 7): validated by magic bytes + size.
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
MEDIA_ROOT = BASE_DIR / "media"  # local storage backend; Supabase bucket in prod
DOCUMENT_STORAGE = os.environ.get("DOCUMENT_STORAGE", "local")  # local | supabase

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Supabase (auth JWT verification + private storage signing)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# AI provider registry (docs/ARCHITECTURE.md §2). "mock" is clearly labeled
# in every API response that used it and is never presented as real output.
EMBEDDINGS_PROVIDER = os.environ.get("EMBEDDINGS_PROVIDER", "mock")
EMBEDDINGS_URL = os.environ.get("EMBEDDINGS_URL", "http://localhost:11434")
EMBEDDINGS_MODEL = os.environ.get("EMBEDDINGS_MODEL", "nomic-embed-text")
