import ast
import asyncio
import json
import logging
import os
import sys
import tempfile
from dataclasses import dataclass

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 30

# Modules backend code is allowed to import. Trade-off: a determined attacker
# can find ways around this (e.g. string-encoded imports via tricks the AST
# validator can't see), but the allowlist kills the easy paths cheaply and
# pairs with cwd=tempdir + minimal env so the blast radius is small even if
# a payload slips past. Keep this list to "data shaping" libraries — no I/O,
# no networking, no subprocess.
_ALLOWED_MODULES = frozenset({
    "json", "math", "re", "datetime", "collections", "itertools",
    "functools", "statistics", "decimal", "fractions", "random",
    "string", "textwrap", "unicodedata", "csv", "copy", "enum",
    "dataclasses", "typing", "abc", "numbers", "uuid", "hashlib",
    "base64", "binascii", "operator", "heapq", "bisect", "array",
})

# Builtin functions that punch holes through the allowlist or do I/O. Direct
# calls (e.g. `eval(...)`) are caught here. Attribute-style calls
# (`__builtins__.eval(...)`) are blocked by the preamble's `delattr` loop in
# the subprocess.
_BLOCKED_BUILTINS = frozenset({
    "exec", "eval", "compile", "__import__", "open", "input",
    "breakpoint", "exit", "quit",
})


class UnsafeCodeError(Exception):
    """Raised when AST validation rejects user-supplied backend code."""


def _validate_code_safety(code: str) -> None:
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise UnsafeCodeError(f"Backend code has a syntax error: {e}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in _ALLOWED_MODULES:
                    raise UnsafeCodeError(
                        f"import of '{alias.name}' is not allowed in backend code "
                        f"(allowed: {sorted(_ALLOWED_MODULES)})"
                    )
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                root = node.module.split(".")[0]
                if root not in _ALLOWED_MODULES:
                    raise UnsafeCodeError(
                        f"from '{node.module}' import ... is not allowed in backend code"
                    )
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in _BLOCKED_BUILTINS:
                raise UnsafeCodeError(
                    f"call to builtin '{node.func.id}()' is not allowed in backend code"
                )


def _minimal_env() -> dict:
    """Build a stripped-down env for the executor subprocess.

    Drops PATH, OPENSWARM_AUTH_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, and
    every other inherited credential. Keeps only what Python itself needs to
    boot on each platform — on Windows that's SYSTEMROOT et al, on POSIX
    nothing is strictly required.
    """
    env = {
        "PYTHONDONTWRITEBYTECODE": "1",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
    }
    if sys.platform == "win32":
        for k in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE"):
            if k in os.environ:
                env[k] = os.environ[k]
    return env


@dataclass
class BackendExecResult:
    result: dict
    stdout: str
    stderr: str


async def execute_backend_code(code: str, input_data: dict) -> BackendExecResult:
    """Execute user-provided Python code in a subprocess.

    The code receives ``input_data`` as a global dict and must assign its
    result to a global ``result`` dict.  User print() calls are captured
    separately from the result via an in-process StringIO redirect.

    Security boundaries (defense in depth — none alone is sufficient):
      1. AST allowlist on imports + blocked-builtin call list.
      2. Subprocess cwd = fresh temp dir (not the OpenSwarm process cwd).
      3. Subprocess env strips PATH, all *_TOKEN / *_API_KEY inheritance.
      4. Preamble scrubs dangerous attrs off `builtins` inside the subprocess
         to catch AST-bypass tricks (e.g. metaclass shenanigans).
      5. 30s wall-clock timeout, killed on overrun.
    """

    _validate_code_safety(code)

    preamble = (
        "import json, sys, io, builtins\n"
        # Defense-in-depth: even with an AST allowlist on the host, scrub
        # dangerous attrs off `builtins` here so attribute-style accesses
        # (e.g. via metaclass.__subclasses__ chains) can't reach them.
        "for _b in ('exec','eval','compile','__import__','open','input',\n"
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

    with tempfile.TemporaryDirectory(prefix="openswarm-exec-") as workdir:
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
            raise RuntimeError(f"Backend code execution timed out after {TIMEOUT_SECONDS}s")

    stderr_text = stderr.decode(errors="replace").strip()

    if proc.returncode != 0:
        raise RuntimeError(f"Backend code error (exit {proc.returncode}): {stderr_text}")

    try:
        parsed = json.loads(stdout.decode())
        return BackendExecResult(
            result=parsed.get("__result__", {}),
            stdout=parsed.get("__stdout__", ""),
            stderr=stderr_text,
        )
    except json.JSONDecodeError:
        raw = stdout.decode(errors="replace").strip()
        raise RuntimeError(
            f"Backend code did not produce valid JSON. Raw output: {raw[:500]}"
        )
