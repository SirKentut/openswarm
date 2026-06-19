"""Tiny in-memory per-key fixed-window rate limiter. Guards /__compute and /__llm
so one visitor or scraper can't burn a creator's budget or our CPU. Best-effort
and single-process: the cloud's budget ledger is the hard backstop, this just
keeps the obvious abuse out cheaply."""
from __future__ import annotations

import time

# Hard ceiling on tracked keys so a flood of unique IPs can't grow the map without
# bound; past it we drop the whole window (everyone gets a fresh allowance).
_MAX_KEYS = 50_000


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.time()
        if len(self._hits) > _MAX_KEYS:
            self._hits.clear()
        bucket = self._hits.get(key)
        if bucket is None:
            bucket = []
            self._hits[key] = bucket
        cutoff = now - self.window
        # Drop timestamps that fell out of the window.
        keep = 0
        for t in bucket:
            if t >= cutoff:
                break
            keep += 1
        if keep:
            del bucket[:keep]
        if len(bucket) >= self.limit:
            return False
        bucket.append(now)
        return True
