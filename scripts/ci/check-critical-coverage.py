#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import pathlib
import sys
import xml.etree.ElementTree as ET


def _norm(path: str) -> str:
    p = path.replace("\\\\", "/").lstrip("./")
    return p


def _match(path: str, pattern: str) -> bool:
    if "*" not in pattern and "?" not in pattern:
        return path == pattern or path.endswith("/" + pattern)
    return fnmatch.fnmatch(path, pattern)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cobertura critical coverage gate")
    parser.add_argument("--coverage-file", required=True)
    # Backward compatibility: legacy line-only flags.
    parser.add_argument("--global-threshold", type=float, default=None)
    parser.add_argument("--critical-threshold", type=float, default=None)
    parser.add_argument("--global-line-threshold", type=float, default=None)
    parser.add_argument("--global-branch-threshold", type=float, default=70.0)
    parser.add_argument("--critical-line-threshold", type=float, default=None)
    parser.add_argument("--critical-branch-threshold", type=float, default=90.0)
    parser.add_argument("--critical", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.critical:
        print("[critical-coverage-gate] missing --critical patterns", file=sys.stderr)
        return 1

    global_line_threshold = (
        args.global_line_threshold
        if args.global_line_threshold is not None
        else (args.global_threshold if args.global_threshold is not None else 85.0)
    )
    critical_line_threshold = (
        args.critical_line_threshold
        if args.critical_line_threshold is not None
        else (args.critical_threshold if args.critical_threshold is not None else 95.0)
    )

    coverage_path = pathlib.Path(args.coverage_file)
    if not coverage_path.exists():
        print(
            f"[critical-coverage-gate] cobertura file not found: {coverage_path}", file=sys.stderr
        )
        return 1

    root = ET.parse(coverage_path).getroot()
    lines_valid = float(root.attrib.get("lines-valid", "0") or 0)
    lines_covered = float(root.attrib.get("lines-covered", "0") or 0)
    branches_valid = float(root.attrib.get("branches-valid", "0") or 0)
    branches_covered = float(root.attrib.get("branches-covered", "0") or 0)
    global_line_percent = 100.0 if lines_valid == 0 else (lines_covered / lines_valid) * 100.0
    global_branch_percent = (
        100.0 if branches_valid == 0 else (branches_covered / branches_valid) * 100.0
    )

    classes: dict[str, tuple[float, float]] = {}
    for class_node in root.findall(".//class"):
        filename = class_node.attrib.get("filename", "")
        line_rate = float(class_node.attrib.get("line-rate", "0") or 0)
        branch_rate = float(class_node.attrib.get("branch-rate", "1") or 1)
        if filename:
            classes[_norm(filename)] = (line_rate * 100.0, branch_rate * 100.0)

    failures: list[str] = []
    if global_line_percent < global_line_threshold:
        failures.append(
            f"global line coverage below threshold: {global_line_percent:.2f}% < {global_line_threshold:.2f}%"
        )
    if global_branch_percent < args.global_branch_threshold:
        failures.append(
            f"global branch coverage below threshold: {global_branch_percent:.2f}% < {args.global_branch_threshold:.2f}%"
        )

    matched_rows: list[tuple[str, str, float, float]] = []
    for pattern in args.critical:
        matches = [(path, metrics) for path, metrics in classes.items() if _match(path, pattern)]
        if not matches:
            failures.append(f"critical pattern unmatched: {pattern}")
            continue
        for path, (line_pct, branch_pct) in matches:
            matched_rows.append((pattern, path, line_pct, branch_pct))
            if line_pct < critical_line_threshold:
                failures.append(
                    f"critical line coverage below threshold: {path} ({line_pct:.2f}% < {critical_line_threshold:.2f}%)"
                )
            if branch_pct < args.critical_branch_threshold:
                failures.append(
                    f"critical branch coverage below threshold: {path} ({branch_pct:.2f}% < {args.critical_branch_threshold:.2f}%)"
                )

    print("[critical-coverage-gate] Coverage summary")
    print(f"- global line: {global_line_percent:.2f}% (threshold {global_line_threshold:.2f}%)")
    print(
        f"- global branch: {global_branch_percent:.2f}% (threshold {args.global_branch_threshold:.2f}%)"
    )
    print(f"- total lines: {int(lines_covered)}/{int(lines_valid)}")
    print(f"- total branches: {int(branches_covered)}/{int(branches_valid)}")
    print("- critical modules:")
    for pattern, path, line_pct, branch_pct in sorted(matched_rows, key=lambda row: row[1]):
        print(f"  - {path}: line {line_pct:.2f}% / branch {branch_pct:.2f}% [pattern: {pattern}]")

    if failures:
        print("[critical-coverage-gate] FAILED", file=sys.stderr)
        for item in failures:
            print(f"- {item}", file=sys.stderr)
        return 1

    print("[critical-coverage-gate] PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
