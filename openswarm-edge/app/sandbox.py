"""Sandboxed Python runner for published apps' backend.py compute.

VENDORED from backend/apps/outputs/executor.py (the desktop App Builder runtime).
Keep the allow/deny lists + the subprocess hardening in sync with that file; this
is the same data-shaping sandbox, just running in the edge instead of on the
desktop. Pure compute only: no network, no disk, no subprocess, no secrets. Safe
to run multi-tenant on one machine because nothing here can reach shared state."""
from __future__ import annotations

import ast
import asyncio
import json
import os
import sys
import tempfile
from dataclasses import dataclass

TIMEOUT_SECONDS = 30

_ALLOWED_MODULES = frozenset({
    "json", "math", "re", "datetime", "collections", "itertools",
    "functools", "statistics", "decimal", "fractions", "random",
    "string", "textwrap", "unicodedata", "csv", "copy", "enum",
    "dataclasses", "typing", "abc", "numbers", "uuid", "hashlib",
    "base64", "binascii", "operator", "heapq", "bisect", "array",
})

_BLOCKED_BUILTINS = frozenset({
    "exec", "eval", "compile", "__import__", "open", "input",
    "breakpoint", "exit", "quit",
})


class UnsafeCodeError(Exception):
    """AST validation rejected the backend code."""


def validate_code_safety(code: str) -> None:
    """Raise UnsafeCodeError on the first AST-visible risk. Published apps are
    vetted at publish time, but we re-check here: the edge never trusts that the
    bundle in storage matches what was scanned."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise UnsafeCodeError(f"Syntax error: {e}")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in _ALLOWED_MODULES:
                    raise UnsafeCodeError(f"import '{alias.name}' is not allowed")
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module.split(".")[0] not in _ALLOWED_MODULES:
                raise UnsafeCodeError(f"import from '{node.module}' is not allowed")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in _BLOCKED_BUILTINS:
                raise UnsafeCodeError(f"builtin '{node.func.id}()' is not allowed")


def _minimal_env() -> dict:
    return {
        "PYTHONDONTWRITEBYTECODE": "1",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }


@dataclass
class ComputeResult:
    result: dict
    stdout: str


async def run_backend(code: str, input_data: dict) -> ComputeResult:
    """Validate + execute user backend code in a hardened subprocess. The code
    reads `input_data` (a global dict) and assigns a global `result` dict."""
    validate_code_safety(code)

    preamble = (
        "import json, sys, io, builtins\n"
        "for _b in ('exec','eval','compile','open','input',\n"
        "           'breakpoint','exit','quit'):\n"
        "    try: delattr(builtins, _b)\n"
        "    except AttributeError: pass\n"
        "_orig_stdout = sys.stdout\n"
        "_capture = io.StringIO()\n"
        "sys.stdout = _capture\n"
        "input_data = json.loads(sys.stdin.read())\n"
        "result = {}\n"
    )
    postamble = (
        "\nsys.stdout = _orig_stdout\n"
        'json.dump({"__stdout__": _capture.getvalue(), "__result__": result}, sys.stdout)\n'
    )
    wrapper = preamble + code + postamble

    with tempfile.TemporaryDirectory(prefix="osw-edge-exec-") as workdir:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", wrapper,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=workdir,
            env=_minimal_env(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=json.dumps(input_data).encode()),
                timeout=TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"compute timed out after {TIMEOUT_SECONDS}s")

    if proc.returncode != 0:
        raise RuntimeError(f"compute failed: {stderr.decode(errors='replace').strip()[:500]}")
    try:
        parsed = json.loads(stdout.decode())
    except json.JSONDecodeError:
        raise RuntimeError("compute did not return valid JSON")
    return ComputeResult(result=parsed.get("__result__", {}), stdout=parsed.get("__stdout__", ""))
