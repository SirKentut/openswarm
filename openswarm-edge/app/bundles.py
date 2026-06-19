"""Fetch + cache published app bundles from Tigris (read-only key). A bundle is a
single apps/{slug}/bundle.tar.gz object; we unpack it once and cache the per-file
bytes keyed by slug with a short TTL so a republish shows up without a restart.
Every path lookup is guarded against traversal and never serves Python source."""
from __future__ import annotations

import asyncio
import io
import mimetypes
import os
import posixpath
import tarfile
import time
from dataclasses import dataclass
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

_ENDPOINT = os.environ.get("TIGRIS_ENDPOINT", "https://fly.storage.tigris.dev")
_BUCKET = os.environ.get("TIGRIS_BUCKET", "openswarm-apps")
_TTL_SECONDS = int(os.environ.get("EDGE_BUNDLE_TTL_SECONDS", "120"))
_MAX_CACHED_BUNDLES = int(os.environ.get("EDGE_BUNDLE_CACHE_MAX", "200"))
_MAX_UNPACKED_BYTES = 100 * 1024 * 1024  # guard against a decompression bomb

# Browsers are picky about these; mimetypes' OS table can disagree across distros.
_MIME_OVERRIDE = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".map": "application/json",
}

_client = None


def _s3():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=_ENDPOINT,
            region_name=os.environ.get("TIGRIS_REGION", "auto"),
            aws_access_key_id=os.environ.get("TIGRIS_ACCESS_KEY_ID", ""),
            aws_secret_access_key=os.environ.get("TIGRIS_SECRET_ACCESS_KEY", ""),
            config=Config(signature_version="s3v4"),
        )
    return _client


@dataclass
class Bundle:
    files: dict[str, bytes]
    backend_code: Optional[str]
    fetched_at: float


_cache: dict[str, Bundle] = {}


def _bundle_key(slug: str) -> str:
    return f"apps/{slug}/bundle.tar.gz"


def unpack(tar_gz: bytes) -> Bundle:
    files: dict[str, bytes] = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(tar_gz), mode="r:gz") as tar:
        for m in tar.getmembers():
            if not m.isfile():
                continue
            name = posixpath.normpath(m.name).lstrip("/")
            if name.startswith("..") or os.path.isabs(name):
                continue
            extracted = tar.extractfile(m)
            if extracted is None:
                continue
            data = extracted.read()
            total += len(data)
            if total > _MAX_UNPACKED_BYTES:
                raise ValueError("bundle exceeds the unpacked-size limit")
            files[name] = data
    backend = files.get("backend.py")
    backend_code = backend.decode("utf-8", errors="replace") if backend is not None else None
    return Bundle(files=files, backend_code=backend_code, fetched_at=time.time())


async def get_bundle(slug: str) -> Optional[Bundle]:
    cached = _cache.get(slug)
    if cached and time.time() - cached.fetched_at < _TTL_SECONDS:
        return cached
    try:
        obj = await asyncio.to_thread(lambda: _s3().get_object(Bucket=_BUCKET, Key=_bundle_key(slug)))
        raw = await asyncio.to_thread(obj["Body"].read)
    except ClientError as e:
        code = str(e.response.get("Error", {}).get("Code", ""))
        if code in ("NoSuchKey", "404", "NoSuchBucket", "AccessDenied"):
            _cache.pop(slug, None)
            return None
        raise
    bundle = unpack(raw)
    if len(_cache) >= _MAX_CACHED_BUNDLES:
        oldest = min(_cache, key=lambda k: _cache[k].fetched_at)
        _cache.pop(oldest, None)
    _cache[slug] = bundle
    return bundle


def resolve_file(bundle: Bundle, path: str) -> Optional[tuple[bytes, str]]:
    """Map a request path to a bundle file, SPA-falling back to index.html. Refuses
    traversal and Python source (served as index.html instead, never as code)."""
    rel = posixpath.normpath(path.lstrip("/"))
    if rel in ("", "."):
        rel = "index.html"
    if rel.startswith("..") or rel.endswith(".py"):
        rel = "index.html"
    data = bundle.files.get(rel)
    if data is None:
        data = bundle.files.get("index.html")
        rel = "index.html"
    if data is None:
        return None
    ext = posixpath.splitext(rel)[1].lower()
    mime = _MIME_OVERRIDE.get(ext) or mimetypes.guess_type(rel)[0] or "application/octet-stream"
    return data, mime
