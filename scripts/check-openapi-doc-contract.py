#!/usr/bin/env python3
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head"}


def _extract_router_prefixes(py_file: Path) -> dict[str, str]:
    tree = ast.parse(py_file.read_text(encoding="utf-8"))
    prefixes: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        value = node.value
        if not isinstance(value, ast.Call):
            continue
        if not isinstance(value.func, ast.Name) or value.func.id != "APIRouter":
            continue
        prefix = ""
        for kw in value.keywords:
            if (
                kw.arg == "prefix"
                and isinstance(kw.value, ast.Constant)
                and isinstance(kw.value.value, str)
            ):
                prefix = kw.value.value
        prefixes[target.id] = prefix
    return prefixes


def _normalized_join(prefix: str, route: str) -> str:
    if route == "":
        joined = prefix or "/"
    elif prefix:
        joined = f"{prefix}{route}"
    else:
        joined = route
    if not joined.startswith("/"):
        joined = f"/{joined}"
    return joined


def _extract_declared_routes(py_file: Path) -> set[str]:
    tree = ast.parse(py_file.read_text(encoding="utf-8"))
    router_prefixes = _extract_router_prefixes(py_file)
    routes: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for deco in node.decorator_list:
            if not isinstance(deco, ast.Call):
                continue
            if not isinstance(deco.func, ast.Attribute):
                continue
            method = deco.func.attr.lower()
            if method not in HTTP_METHODS:
                continue
            target = deco.func.value
            if not isinstance(target, ast.Name):
                continue
            if target.id not in router_prefixes and target.id != "app":
                continue
            include_in_schema_false = False
            for kw in deco.keywords:
                if (
                    kw.arg == "include_in_schema"
                    and isinstance(kw.value, ast.Constant)
                    and kw.value.value is False
                ):
                    include_in_schema_false = True
            if include_in_schema_false:
                continue
            if (
                not deco.args
                or not isinstance(deco.args[0], ast.Constant)
                or not isinstance(deco.args[0].value, str)
            ):
                continue
            route = deco.args[0].value
            prefix = router_prefixes.get(target.id, "")
            full_path = _normalized_join(prefix, route)
            routes.add(f"{method.upper()} {full_path}")
    return routes


def _extract_implemented_routes(repo_root: Path) -> set[str]:
    implemented: set[str] = set()
    api_dir = repo_root / "backend" / "app" / "api"
    for py_file in sorted(api_dir.glob("*.py")):
        implemented |= _extract_declared_routes(py_file)
    main_file = repo_root / "backend" / "app" / "main.py"
    if main_file.exists():
        implemented |= _extract_declared_routes(main_file)
    return implemented


def _extract_openapi_routes(openapi_file: Path) -> set[str]:
    lines = openapi_file.read_text(encoding="utf-8").splitlines()
    routes: set[str] = set()
    in_paths = False
    current_path: str | None = None
    for line in lines:
        if line.strip() == "paths:":
            in_paths = True
            current_path = None
            continue
        if in_paths and re.match(r"^[A-Za-z_].*:$", line):
            break
        if not in_paths:
            continue
        path_match = re.match(r"^  (/[^:]*):\s*$", line)
        if path_match:
            current_path = path_match.group(1)
            continue
        method_match = re.match(r"^    (get|post|put|patch|delete|options|head):\s*$", line)
        if method_match and current_path:
            routes.add(f"{method_match.group(1).upper()} {current_path}")
    return routes


def _extract_doc_routes(doc_file: Path) -> set[str]:
    text = doc_file.read_text(encoding="utf-8")
    matches = re.findall(r"`(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(/[^` ]*)`", text)
    return {f"{method} {path}" for method, path in matches}


def _print_diff(label: str, expected: set[str], actual: set[str]) -> int:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if not missing and not extra:
        print(f"[ok] {label}: aligned ({len(expected)} endpoints)")
        return 0
    print(f"[error] {label}: mismatch")
    if missing:
        print(f"  missing in target ({len(missing)}):")
        for item in missing:
            print(f"    - {item}")
    if extra:
        print(f"  extra in target ({len(extra)}):")
        for item in extra:
            print(f"    - {item}")
    return 1


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    openapi_file = repo_root / "contracts" / "openapi" / "api.yaml"
    doc_file = repo_root / "docs" / "reference" / "universal-api.md"
    implemented = _extract_implemented_routes(repo_root)
    openapi = _extract_openapi_routes(openapi_file)
    docs = _extract_doc_routes(doc_file)

    failures = 0
    failures += _print_diff("OpenAPI vs implementation", implemented, openapi)
    failures += _print_diff("Docs vs implementation", implemented, docs)
    if failures:
        print("[fail] openapi/doc contract mismatch detected")
        return 1
    print("[pass] openapi/doc contract check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
