#!/usr/bin/env bash
set -euo pipefail

uiq_normalize_abs_path() {
  python3 - "$1" <<'PY'
import os
import sys

print(os.path.realpath(os.path.abspath(sys.argv[1])))
PY
}

uiq_normalize_contract_path() {
  python3 - "$1" <<'PY'
import os
import sys

print(os.path.abspath(os.path.normpath(sys.argv[1])))
PY
}

uiq_resolve_parent_workspace_node_modules_root() {
  local root_dir="$1"
  python3 - "$root_dir" <<'PY'
import os
import sys

root = os.path.realpath(os.path.abspath(sys.argv[1]))
print(os.path.join(os.path.dirname(root), "node_modules"))
PY
}

uiq_explicit_node_modules_dir_allowed() {
  local root_dir="$1"
  local candidate_raw="$2"
  local candidate_contract_dir
  local candidate_dir
  candidate_contract_dir="$(uiq_normalize_contract_path "$candidate_raw")"
  candidate_dir="$(uiq_normalize_abs_path "$candidate_raw")"
  local repo_local_node_root
  repo_local_node_root="$(uiq_normalize_contract_path "${root_dir}/node_modules")"
  local repo_family_fallback
  repo_family_fallback="$(uiq_normalize_abs_path "$(uiq_resolve_repo_family_node_fallback)")"
  local runtime_bridge_root
  runtime_bridge_root="$(uiq_normalize_abs_path "$(uiq_resolve_runtime_bridge_root)")"

  if [[ "$candidate_contract_dir" == "$repo_local_node_root" ]]; then
    return 0
  fi
  if [[ "$candidate_dir" == "$repo_family_fallback" ]]; then
    return 0
  fi
  if [[ "$candidate_dir" == "$runtime_bridge_root" ]]; then
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* ]]; then
    local runner_temp_node_root
    runner_temp_node_root="$(uiq_normalize_abs_path "${RUNNER_TEMP}/uiq-node-modules")"
    if [[ "$candidate_dir" == "$runner_temp_node_root" ]]; then
      return 0
    fi
  fi

  return 1
}

uiq_resolve_node_modules_dir() {
  local root_dir="$1"
  if [[ -n "${UIQ_NODE_MODULES_DIR:-}" ]]; then
    local explicit_dir="$UIQ_NODE_MODULES_DIR"
    local repo_local_node_root="${root_dir}/node_modules"
    if ! uiq_explicit_node_modules_dir_allowed "$root_dir" "$explicit_dir"; then
      echo "error: UIQ_NODE_MODULES_DIR must stay inside the repo-local node_modules root, RUNNER_TEMP bridge, runtime bridge, or repo-family cache; refusing ${explicit_dir}" >&2
      return 1
    fi
    local explicit_contract_dir
    explicit_contract_dir="$(uiq_normalize_contract_path "$explicit_dir")"
    repo_local_node_root="$(uiq_normalize_contract_path "$repo_local_node_root")"
    if [[ "$explicit_contract_dir" == "$repo_local_node_root" ]]; then
      printf '%s\n' "$repo_local_node_root"
      return 0
    fi
    explicit_dir="$(uiq_normalize_abs_path "$explicit_dir")"
    printf '%s\n' "$explicit_dir"
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* ]]; then
    printf '%s\n' "${RUNNER_TEMP}/uiq-node-modules"
    return 0
  fi
  printf '%s\n' "${root_dir}/node_modules"
}

uiq_resolve_authoritative_workspace_node_root() {
  local root_dir="$1"
  printf '%s\n' "${root_dir}/node_modules"
}

uiq_resolve_repo_family_node_fallback() {
  printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/uiq/node-modules"
}

uiq_resolve_runtime_bridge_root() {
  printf '%s\n' "/tmp/uiq-runner/uiq-node-modules"
}

uiq_node_modules_resolution_mode() {
  if [[ -n "${UIQ_NODE_MODULES_DIR:-}" ]]; then
    local root_dir="${1:-$(pwd)}"
    if ! uiq_explicit_node_modules_dir_allowed "$root_dir" "${UIQ_NODE_MODULES_DIR}"; then
      echo "error: UIQ_NODE_MODULES_DIR must stay inside governed node_modules roots" >&2
      return 1
    fi
    if [[ "$(uiq_normalize_contract_path "${UIQ_NODE_MODULES_DIR}")" == "$(uiq_normalize_contract_path "${root_dir}/node_modules")" ]]; then
      printf '%s\n' "workspace_default"
      return 0
    fi
    printf '%s\n' "explicit"
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* ]]; then
    printf '%s\n' "runner_temp"
    return 0
  fi
  printf '%s\n' "workspace_default"
}

uiq_node_modules_contract_probe() {
  local root_dir="$1"
  local authoritative_root
  authoritative_root="$(uiq_resolve_authoritative_workspace_node_root "$root_dir")"
  local fallback_root
  fallback_root="$(uiq_resolve_repo_family_node_fallback)"
  local runtime_bridge_root
  runtime_bridge_root="$(uiq_resolve_runtime_bridge_root)"
  local resolved_shared_root
  resolved_shared_root="$(uiq_resolve_node_modules_dir "$root_dir")"
  local resolution_mode
  resolution_mode="$(uiq_node_modules_resolution_mode)"
  local root_bridge_path="${root_dir}/node_modules"

  python3 - "$root_dir" "$authoritative_root" "$fallback_root" "$runtime_bridge_root" "$resolved_shared_root" "$resolution_mode" "$root_bridge_path" <<'PY'
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
authoritative_input = os.path.abspath(os.path.normpath(sys.argv[2]))
authoritative_root = os.path.join(os.path.realpath(os.path.dirname(authoritative_input)), os.path.basename(authoritative_input))
fallback_root = os.path.realpath(sys.argv[3])
runtime_bridge_root = os.path.realpath(sys.argv[4])
resolved_shared_root = os.path.realpath(sys.argv[5])
resolution_mode = sys.argv[6]
root_bridge_path = Path(sys.argv[7])


def inspect(path_obj: Path) -> dict[str, object]:
    if not path_obj.exists() and not path_obj.is_symlink():
        return {
            "path": str(path_obj),
            "present": False,
            "kind": "absent",
            "target": None,
            "target_exists": False,
            "dangling": False,
        }

    if path_obj.is_symlink():
        target_raw = os.readlink(path_obj)
        resolved_target = os.path.realpath(path_obj)
        target_exists = os.path.exists(resolved_target)
        return {
            "path": str(path_obj),
            "present": True,
            "kind": "symlink",
            "target": resolved_target,
            "target_raw": target_raw,
            "target_exists": target_exists,
            "dangling": not target_exists,
        }

    kind = "directory" if path_obj.is_dir() else "file"
    return {
        "path": str(path_obj),
        "present": True,
        "kind": kind,
        "target": str(path_obj.resolve()),
        "target_exists": True,
        "dangling": False,
    }


root_bridge = inspect(root_bridge_path)
runtime_bridge = inspect(Path(runtime_bridge_root))

root_target = root_bridge.get("target")
runtime_target = runtime_bridge.get("target")

payload = {
    "repoRoot": str(repo_root),
    "authoritativeWorkspaceNodeRoot": authoritative_root,
    "repoFamilyNodeFallback": fallback_root,
    "runtimeBridgeRoot": runtime_bridge_root,
    "resolvedSharedNodeRoot": resolved_shared_root,
    "resolutionMode": resolution_mode,
    "rootBridge": {
        **root_bridge,
        "pointsToAuthoritativeWorkspaceRoot": root_target == authoritative_root,
        "pointsToRepoFamilyFallback": root_target == fallback_root,
        "pointsToResolvedSharedRoot": root_target == resolved_shared_root,
    },
    "runtimeBridge": {
        **runtime_bridge,
        "pointsToResolvedSharedRoot": runtime_target == resolved_shared_root,
    },
    "currentUsesRuntimeBridge": resolved_shared_root == runtime_bridge_root,
}

print(json.dumps(payload, ensure_ascii=False))
PY
}

uiq_resolve_pnpm_store_dir() {
  if [[ -n "${UIQ_PNPM_STORE_DIR:-}" ]]; then
    printf '%s\n' "$UIQ_PNPM_STORE_DIR"
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* ]]; then
    printf '%s\n' "${RUNNER_TEMP}/uiq-pnpm-store"
    return 0
  fi
  printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/uiq/pnpm-store"
}

uiq_resolve_corepack_home() {
  if [[ -n "${COREPACK_HOME:-}" ]]; then
    printf '%s\n' "$COREPACK_HOME"
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* ]]; then
    printf '%s\n' "${RUNNER_TEMP}/uiq-corepack"
    return 0
  fi
  printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack"
}

uiq_normalize_runner_temp_child_path() {
  local raw_path="$1"
  local child_name="$2"
  if [[ -z "$raw_path" || "$raw_path" == /* ]]; then
    printf '%s\n' "$raw_path"
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* ]]; then
    local expected_relative="${RUNNER_TEMP#/}/${child_name}"
    if [[ "$raw_path" == "$expected_relative" ]]; then
      printf '/%s\n' "$raw_path"
      return 0
    fi
  fi
  printf '%s\n' "$raw_path"
}

uiq_export_node_env() {
  local root_dir="$1"
  local resolved_node_modules_dir
  resolved_node_modules_dir="$(uiq_resolve_node_modules_dir "$root_dir")"
  local resolved_pnpm_store_dir="${UIQ_PNPM_STORE_DIR:-$(uiq_resolve_pnpm_store_dir)}"
  local resolved_corepack_home="${COREPACK_HOME:-$(uiq_resolve_corepack_home)}"
  local authoritative_contract_root
  local npm_modules_dir
  local npm_virtual_store_dir
  resolved_node_modules_dir="$(uiq_normalize_runner_temp_child_path "$resolved_node_modules_dir" "uiq-node-modules")"
  resolved_pnpm_store_dir="$(uiq_normalize_runner_temp_child_path "$resolved_pnpm_store_dir" "uiq-pnpm-store")"
  resolved_corepack_home="$(uiq_normalize_runner_temp_child_path "$resolved_corepack_home" "uiq-corepack")"
  authoritative_contract_root="$(uiq_normalize_contract_path "$(uiq_resolve_authoritative_workspace_node_root "$root_dir")")"
  npm_modules_dir="$resolved_node_modules_dir"
  npm_virtual_store_dir="${resolved_node_modules_dir}/.pnpm"
  if [[ "$(uiq_normalize_contract_path "$resolved_node_modules_dir")" == "$authoritative_contract_root" ]]; then
    uiq_prepare_authoritative_workspace_node_root "$root_dir"
    # pnpm treats path-like config values as project-relative in some install flows.
    # Keep the repo-local authoritative root expressed canonically to avoid materializing
    # "<workspace>/<absolute-path-without-leading-slash>/node_modules" inside subtrees.
    npm_modules_dir="node_modules"
    npm_virtual_store_dir="node_modules/.pnpm"
  fi
  export UIQ_NODE_MODULES_DIR="$resolved_node_modules_dir"
  export UIQ_PNPM_STORE_DIR="$resolved_pnpm_store_dir"
  export COREPACK_HOME="$resolved_corepack_home"
  export PNPM_STORE_PATH="$UIQ_PNPM_STORE_DIR"
  export npm_config_store_dir="$UIQ_PNPM_STORE_DIR"
  export npm_config_modules_dir="$npm_modules_dir"
  export npm_config_virtual_store_dir="$npm_virtual_store_dir"
  export NODE_PATH="${UIQ_NODE_MODULES_DIR}${NODE_PATH:+:${NODE_PATH}}"
  export PATH="${UIQ_NODE_MODULES_DIR}/.bin:${PATH}"
  case " ${NODE_OPTIONS:-} " in
    *" --preserve-symlinks "*) ;;
    *) export NODE_OPTIONS="--preserve-symlinks ${NODE_OPTIONS:-}" ;;
  esac
  case " ${NODE_OPTIONS:-} " in
    *" --preserve-symlinks-main "*) ;;
    *) export NODE_OPTIONS="--preserve-symlinks-main ${NODE_OPTIONS:-}" ;;
  esac
  mkdir -p "$UIQ_NODE_MODULES_DIR" "${UIQ_NODE_MODULES_DIR}/.pnpm" "$UIQ_PNPM_STORE_DIR" "$COREPACK_HOME"
}

uiq_should_skip_node_link_repair() {
  case "${UIQ_SKIP_NODE_LINK_REPAIR:-0}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
  esac
  return 1
}

uiq_should_preserve_root_node_modules() {
  local root_dir="$1"
  local shared_dir="${UIQ_NODE_MODULES_DIR:-$(uiq_resolve_node_modules_dir "$root_dir")}"
  [[ "$(uiq_normalize_contract_path "$shared_dir")" == "$(uiq_normalize_contract_path "${root_dir}/node_modules")" ]]
}

uiq_prepare_authoritative_workspace_node_root() {
  local root_dir="$1"
  local authoritative_root="${root_dir}/node_modules"
  if [[ -L "$authoritative_root" ]]; then
    rm -f "$authoritative_root"
    return 0
  fi
  if [[ -e "$authoritative_root" && ! -d "$authoritative_root" ]]; then
    rm -f "$authoritative_root"
  fi
}

uiq_workspace_node_module_link_specs() {
  local root_dir="$1"
  cat <<EOF
${root_dir}/contracts/node_modules:../node_modules
${root_dir}/apps/command-center/node_modules:../../node_modules
${root_dir}/tooling/automation/node_modules:../../node_modules
${root_dir}/tests/web-harness/node_modules:../../node_modules
${root_dir}/services/mcp-server/node_modules:../../node_modules
${root_dir}/tests/node_modules:../node_modules
${root_dir}/tests/frontend-e2e/node_modules:../node_modules
EOF
}

uiq_workspace_node_modules_topology_ready() {
  local root_dir="$1"
  local shared_dir="${2:-${UIQ_NODE_MODULES_DIR:-$(uiq_resolve_node_modules_dir "$root_dir")}}"
  local root_node_modules="${root_dir}/node_modules"
  local link_spec=""
  local workspace_path=""
  if [[ "$(uiq_normalize_contract_path "$shared_dir")" == "$(uiq_normalize_contract_path "$root_node_modules")" ]]; then
    [[ -d "$root_node_modules" && ! -L "$root_node_modules" ]] || return 1
  else
    [[ -L "$root_node_modules" && -e "$root_node_modules" ]] || return 1
    [[ "$(uiq_normalize_abs_path "$root_node_modules")" == "$(uiq_normalize_abs_path "$shared_dir")" ]] || return 1
  fi
  while IFS= read -r link_spec; do
    [[ -n "$link_spec" ]] || continue
    workspace_path="${link_spec%%:*}"
    [[ -L "$workspace_path" && -e "$workspace_path" ]] || return 1
    [[ "$(uiq_normalize_abs_path "$workspace_path")" == "$(uiq_normalize_abs_path "$shared_dir")" ]] || return 1
  done < <(uiq_workspace_node_module_link_specs "$root_dir")
  return 0
}

uiq_workspace_install_state_ready() {
  local root_dir="$1"
  local shared_dir="${2:-${UIQ_NODE_MODULES_DIR:-$(uiq_resolve_node_modules_dir "$root_dir")}}"
  python3 - "$root_dir" "$shared_dir" <<'PY'
from __future__ import annotations

import json
import os
import platform
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
shared = Path(os.path.abspath(os.path.normpath(sys.argv[2])))
issues: list[str] = []


def append_issue(message: str) -> None:
    if message not in issues:
        issues.append(message)


def check_workspace_state() -> None:
    state_file = shared / ".pnpm-workspace-state-v1.json"
    if not state_file.exists():
        return

    try:
        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive parse guard
        append_issue(f"workspace-state-unreadable path={state_file} error={exc}")
        return

    projects = payload.get("projects") or {}
    if not isinstance(projects, dict):
        append_issue(f"workspace-state-invalid path={state_file}")
        return

    project_roots = sorted(os.path.realpath(os.path.abspath(str(path))) for path in projects.keys())
    if not project_roots:
        return

    actual_root = str(root)
    if actual_root in project_roots or actual_root == "/workspace":
        return

    container_roots = [path for path in project_roots if path.startswith("/workspace")]
    recorded_root = container_roots[0] if container_roots else project_roots[0]
    append_issue(
        f"workspace-state-root-mismatch actual={actual_root} recorded={recorded_root}"
    )


def check_container_absolute_links(base_dir: Path) -> None:
    if not base_dir.exists():
        return
    try:
        children = list(base_dir.iterdir())
    except OSError:
        return

    for child in children:
        try:
            if not child.is_symlink():
                continue
            raw_target = os.readlink(child)
        except OSError:
            continue
        if raw_target.startswith("/workspace/"):
            append_issue(f"container-absolute-link path={child} target={raw_target}")
            return


def parse_version(raw: str) -> tuple[int, ...]:
    parts = []
    for token in raw.split("."):
        digits = []
        for ch in token:
            if ch.isdigit():
                digits.append(ch)
            else:
                break
        if not digits:
            break
        parts.append(int("".join(digits)))
    return tuple(parts)


def compare_version(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    max_len = max(len(left), len(right))
    padded_left = left + (0,) * (max_len - len(left))
    padded_right = right + (0,) * (max_len - len(right))
    if padded_left < padded_right:
        return -1
    if padded_left > padded_right:
        return 1
    return 0


def version_satisfies(version: str, spec: str) -> bool:
    spec = spec.strip()
    if not spec:
        return True
    version_tuple = parse_version(version)
    expected_tuple = parse_version(spec.lstrip("^~>=< "))
    if not version_tuple or not expected_tuple:
        return True
    if spec.startswith("^"):
        return version_tuple[0] == expected_tuple[0] and compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith("~"):
        return version_tuple[:2] == expected_tuple[:2] and compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith(">="):
        return compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith(">"):
        return compare_version(version_tuple, expected_tuple) > 0
    if spec.startswith("<="):
        return compare_version(version_tuple, expected_tuple) <= 0
    if spec.startswith("<"):
        return compare_version(version_tuple, expected_tuple) < 0
    return version_tuple[: len(expected_tuple)] == expected_tuple


def check_direct_dependency_links() -> None:
    package_json = root / "package.json"
    if not package_json.exists():
        return

    try:
        payload = json.loads(package_json.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive parse guard
        append_issue(f"package-json-unreadable path={package_json} error={exc}")
        return

    dependencies: dict[str, str] = {}
    for section in ("dependencies", "devDependencies"):
        dependency_map = payload.get(section) or {}
        if not isinstance(dependency_map, dict):
            continue
        for name, spec in dependency_map.items():
            if isinstance(name, str) and name.strip():
                dependencies[name] = str(spec or "").strip()

    for name, spec in sorted(dependencies.items()):
        package_path = shared / name
        try:
            present = package_path.exists() or package_path.is_symlink()
        except OSError:
            present = False
        if not present:
            append_issue(f"missing-direct-dependency-links package={name}")
            return
        package_json_path = package_path / "package.json"
        try:
            package_payload = json.loads(package_json_path.read_text(encoding="utf-8"))
        except Exception:
            append_issue(f"missing-direct-dependency-links package={name}")
            return
        version = str(package_payload.get("version") or "").strip()
        if not version or not version_satisfies(version, spec):
            append_issue(f"missing-direct-dependency-links package={name}")
            return


def detect_rollup_native_package() -> tuple[str, str] | None:
    if sys.platform != "darwin":
        return None

    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        package_base = "darwin-arm64"
    elif machine in {"x86_64", "amd64"}:
        package_base = "darwin-x64"
    else:
        return None

    candidates = sorted(shared.glob(".pnpm/rollup@*/node_modules/rollup/package.json"))
    if not candidates:
        return None

    try:
        version = str(
            json.loads(candidates[-1].read_text(encoding="utf-8")).get("version") or ""
        ).strip()
    except Exception:
        return None
    if not version:
        return None
    return package_base, version


check_workspace_state()

if str(root) != "/workspace":
    check_container_absolute_links(shared)
    check_container_absolute_links(shared / ".pnpm" / "node_modules")

check_direct_dependency_links()

rollup_native = detect_rollup_native_package()
if rollup_native is not None:
    package_base, version = rollup_native
    expected_store_dir = shared / ".pnpm" / f"@rollup+rollup-{package_base}@{version}"
    if not expected_store_dir.exists():
        append_issue(
            f"missing-rollup-native package=@rollup/rollup-{package_base} version={version}"
        )

if issues:
    for issue in issues:
        print(f"[install-state] {issue}", file=sys.stderr)
    raise SystemExit(1)
PY
}

uiq_resolve_node_executable() {
  if [[ -n "${UIQ_NODE_EXECUTABLE:-}" && -x "${UIQ_NODE_EXECUTABLE}" ]]; then
    printf '%s\n' "$UIQ_NODE_EXECUTABLE"
    return 0
  fi

  local candidate=""
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    [[ -x "$candidate" ]] || continue
    case "$candidate" in
      "${UIQ_NODE_MODULES_DIR:-}/.bin/"*) continue ;;
    esac
    printf '%s\n' "$candidate"
    return 0
  done < <(type -aP node 2>/dev/null || true)

  candidate="$(command -v node 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    case "$candidate" in
      "${UIQ_NODE_MODULES_DIR:-}/.bin/"*) ;;
      *)
        printf '%s\n' "$candidate"
        return 0
        ;;
    esac
  fi

  return 1
}

uiq_cleanup_root_node_artifacts() {
  local root_dir="$1"
  local preserve_root_node_modules="${2:-auto}"
  if [[ "$preserve_root_node_modules" == "auto" ]]; then
    if uiq_should_preserve_root_node_modules "$root_dir"; then
      preserve_root_node_modules=1
    else
      preserve_root_node_modules=0
    fi
  fi
  local root_node_modules="${root_dir}/node_modules"
  if [[ "$preserve_root_node_modules" == "1" ]]; then
    if [[ -L "$root_node_modules" ]]; then
      rm -f "$root_node_modules"
    elif [[ -e "$root_node_modules" && ! -d "$root_node_modules" ]]; then
      rm -f "$root_node_modules"
    fi
  else
    if [[ -L "$root_node_modules" ]]; then
      rm -f "$root_node_modules"
    elif [[ -d "$root_node_modules" ]]; then
      rm -rf "$root_node_modules"
    elif [[ -e "$root_node_modules" ]]; then
      rm -f "$root_node_modules"
    fi
  fi
  rm -rf "${root_dir}/.pnpm-store" "${root_dir}/Users" "${root_dir}/var"
  rm -rf \
    "${root_dir}/contracts/node_modules" \
    "${root_dir}/apps/command-center/node_modules" \
    "${root_dir}/apps/command-center/workspace/node_modules" \
    "${root_dir}/tooling/automation/node_modules" \
    "${root_dir}/tooling/automation/workspace/node_modules" \
    "${root_dir}/tests/web-harness/node_modules" \
    "${root_dir}/services/mcp-server/node_modules" \
    "${root_dir}/services/mcp-server/workspace/node_modules" \
    "${root_dir}/tests/node_modules" \
    "${root_dir}/tests/frontend-e2e/node_modules" \
    "${root_dir}/apps/command-center/workspace/.runtime-cache" \
    "${root_dir}/tooling/automation/workspace/.runtime-cache" \
    "${root_dir}/services/mcp-server/workspace/.runtime-cache" \
    "${root_dir}/apps/command-center/Users" \
    "${root_dir}/apps/command-center/var" \
    "${root_dir}/tooling/automation/Users" \
    "${root_dir}/tooling/automation/var" \
    "${root_dir}/tests/web-harness/Users" \
    "${root_dir}/tests/web-harness/var" \
    "${root_dir}/services/mcp-server/Users" \
    "${root_dir}/services/mcp-server/var"
}

uiq_assert_no_parent_workspace_node_modules() {
  local root_dir="$1"
  local parent_node_modules
  parent_node_modules="$(uiq_resolve_parent_workspace_node_modules_root "$root_dir")"
  if [[ -e "$parent_node_modules" || -L "$parent_node_modules" ]]; then
    echo "error: legacy parent-workspace node_modules detected at ${parent_node_modules}; current contract requires repo-local authoritative root only" >&2
    return 1
  fi
  return 0
}

uiq_link_workspace_node_modules() {
  local root_dir="$1"
  local shared_dir="${UIQ_NODE_MODULES_DIR:-$(uiq_resolve_node_modules_dir "$root_dir")}"
  local root_node_modules="${root_dir}/node_modules"
  local preserve_root_node_modules=0
  local workspace_path=""
  local target_path=""
  local link_spec=""

  if [[ "$shared_dir" == "$root_node_modules" ]]; then
    preserve_root_node_modules=1
  fi

  uiq_atomic_symlink() {
    local target_path="$1"
    local link_path="$2"
    python3 - "$target_path" "$link_path" <<'PY'
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

target = sys.argv[1]
link_path = Path(sys.argv[2])
link_path.parent.mkdir(parents=True, exist_ok=True)

if link_path.exists() or link_path.is_symlink():
    if link_path.is_dir() and not link_path.is_symlink():
        shutil.rmtree(link_path)
    else:
        link_path.unlink(missing_ok=True)

tmp_link = link_path.parent / f".{link_path.name}.tmp-{os.getpid()}"
if tmp_link.exists() or tmp_link.is_symlink():
    if tmp_link.is_dir() and not tmp_link.is_symlink():
        shutil.rmtree(tmp_link)
    else:
        tmp_link.unlink(missing_ok=True)

os.symlink(target, tmp_link)
os.replace(tmp_link, link_path)
PY
  }

  uiq_cleanup_root_node_artifacts "$root_dir" "$preserve_root_node_modules"
  mkdir -p "$shared_dir"
  mkdir -p "${shared_dir}/.pnpm"
  if [[ "$preserve_root_node_modules" != "1" ]]; then
    uiq_atomic_symlink "$shared_dir" "$root_node_modules"
  fi

  while IFS= read -r link_spec; do
    [[ -n "$link_spec" ]] || continue
    workspace_path="${link_spec%%:*}"
    target_path="${link_spec#*:}"
    uiq_atomic_symlink "$target_path" "$workspace_path"
  done < <(uiq_workspace_node_module_link_specs "$root_dir")
}

uiq_shared_link_repair_fingerprint() {
  local root_dir="$1"
  python3 - "$root_dir" <<'PY'
from pathlib import Path
import hashlib
import sys

root = Path(sys.argv[1])
paths = [root / "package.json", root / "pnpm-lock.yaml", root / "scripts/lib/node-toolchain.sh"]
for pattern in (
    "apps/*/package.json",
    "services/*/package.json",
    "tooling/*/package.json",
    "packages/*/package.json",
    "packages/*/*/package.json",
    "contracts/package.json",
):
    paths.extend(sorted(root.glob(pattern)))

digest = hashlib.sha256()
for path in sorted({p for p in paths if p.exists()}):
    digest.update(str(path.relative_to(root)).encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PY
}

uiq_dir_has_entries() {
  local dir_path="$1"
  [[ -d "$dir_path" ]] || return 1
  find "$dir_path" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

uiq_shared_node_cache_ready_for_shortcut() {
  local root_dir="$1"
  local shared_dir="$2"
  uiq_dir_has_entries "${shared_dir}/.pnpm" || return 1
  python3 - "$root_dir" "$shared_dir" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
shared = Path(sys.argv[2])
package_json = root / "package.json"
if not package_json.exists():
    raise SystemExit(1)

payload = json.loads(package_json.read_text(encoding="utf-8"))
dependencies: dict[str, str] = {}
for section in ("dependencies", "devDependencies"):
    dependency_map = payload.get(section) or {}
    if isinstance(dependency_map, dict):
        for name, spec in dependency_map.items():
            if isinstance(name, str) and name.strip():
                dependencies[name] = str(spec or "").strip()

def parse_version(raw: str) -> tuple[int, ...]:
    parts = []
    for token in raw.split("."):
        digits = []
        for ch in token:
            if ch.isdigit():
                digits.append(ch)
            else:
                break
        if not digits:
            break
        parts.append(int("".join(digits)))
    return tuple(parts)

def compare_version(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    max_len = max(len(left), len(right))
    padded_left = left + (0,) * (max_len - len(left))
    padded_right = right + (0,) * (max_len - len(right))
    if padded_left < padded_right:
        return -1
    if padded_left > padded_right:
        return 1
    return 0

def version_satisfies(version: str, spec: str) -> bool:
    spec = spec.strip()
    if not spec:
        return True
    version_tuple = parse_version(version)
    expected_tuple = parse_version(spec.lstrip("^~>=< "))
    if not version_tuple or not expected_tuple:
        return True
    if spec.startswith("^"):
        return version_tuple[0] == expected_tuple[0] and compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith("~"):
        return version_tuple[:2] == expected_tuple[:2] and compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith(">="):
        return compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith(">"):
        return compare_version(version_tuple, expected_tuple) > 0
    if spec.startswith("<="):
        return compare_version(version_tuple, expected_tuple) <= 0
    if spec.startswith("<"):
        return compare_version(version_tuple, expected_tuple) < 0
    return version_tuple[: len(expected_tuple)] == expected_tuple

def dependency_ready(name: str, spec: str) -> bool:
    package_path = shared / name
    try:
        present = package_path.exists() or package_path.is_symlink()
    except OSError:
        return False
    if not present:
        return False
    package_json_path = package_path / "package.json"
    try:
        if not package_json_path.exists():
            return False
        package_payload = json.loads(package_json_path.read_text(encoding="utf-8"))
    except (OSError, Exception):
        return False
    version = str(package_payload.get("version") or "").strip()
    if not version:
        return False
    return version_satisfies(version, spec)

all_ready = all(dependency_ready(name, spec) for name, spec in sorted(dependencies.items()))
raise SystemExit(0 if all_ready else 1)
PY
}

uiq_refresh_direct_shared_links() {
  local root_dir="$1"
  local shared_dir="$2"
  python3 - "$root_dir" "$shared_dir" <<'PY'
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
shared = Path(sys.argv[2])
store = shared / ".pnpm"
package_json = root / "package.json"
if not package_json.exists() or not store.exists():
    raise SystemExit(1)

payload = json.loads(package_json.read_text(encoding="utf-8"))
dependencies: dict[str, str] = {}
for section in ("dependencies", "devDependencies"):
    dependency_map = payload.get(section) or {}
    if isinstance(dependency_map, dict):
        for name, spec in dependency_map.items():
            if isinstance(name, str) and name.strip():
                dependencies[name] = str(spec or "").strip()

def parse_version(raw: str) -> tuple[int, ...]:
    parts = []
    for token in raw.split("."):
        digits = []
        for ch in token:
            if ch.isdigit():
                digits.append(ch)
            else:
                break
        if not digits:
            break
        parts.append(int("".join(digits)))
    return tuple(parts)

def compare_version(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    max_len = max(len(left), len(right))
    padded_left = left + (0,) * (max_len - len(left))
    padded_right = right + (0,) * (max_len - len(right))
    if padded_left < padded_right:
        return -1
    if padded_left > padded_right:
        return 1
    return 0

def version_satisfies(version: str, spec: str) -> bool:
    spec = spec.strip()
    if not spec:
        return True
    version_tuple = parse_version(version)
    expected_tuple = parse_version(spec.lstrip("^~>=< "))
    if not version_tuple or not expected_tuple:
        return True
    if spec.startswith("^"):
        return version_tuple[0] == expected_tuple[0] and compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith("~"):
        return version_tuple[:2] == expected_tuple[:2] and compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith(">="):
        return compare_version(version_tuple, expected_tuple) >= 0
    if spec.startswith(">"):
        return compare_version(version_tuple, expected_tuple) > 0
    if spec.startswith("<="):
        return compare_version(version_tuple, expected_tuple) <= 0
    if spec.startswith("<"):
        return compare_version(version_tuple, expected_tuple) < 0
    return version_tuple[: len(expected_tuple)] == expected_tuple

def safe_resolve(path_obj: Path) -> Path | None:
    try:
        return path_obj.resolve()
    except (RuntimeError, OSError):
        return None

def safe_path_exists(path_obj: Path) -> bool:
    try:
        return path_obj.exists() or path_obj.is_symlink()
    except OSError:
        return False

def safe_is_symlink(path_obj: Path) -> bool:
    try:
        return path_obj.is_symlink()
    except OSError:
        return False

def safe_is_dir(path_obj: Path) -> bool:
    try:
        return path_obj.is_dir()
    except OSError:
        return False

def reset_path(path_obj: Path) -> None:
    if safe_path_exists(path_obj):
        if safe_is_dir(path_obj) and not safe_is_symlink(path_obj):
            shutil.rmtree(path_obj)
        else:
            path_obj.unlink(missing_ok=True)

def safe_symlink(path_obj: Path, target: Path) -> None:
    last_error: FileExistsError | None = None
    for _ in range(3):
        try:
            path_obj.symlink_to(target)
            return
        except FileExistsError as exc:
            last_error = exc
            resolved_existing = safe_resolve(path_obj)
            resolved_target = safe_resolve(target)
            if resolved_existing is not None and resolved_target is not None and resolved_existing == resolved_target:
                return
            reset_path(path_obj)
    if last_error is not None:
        raise last_error

def link_path(path_obj: Path, target: Path) -> None:
    path_obj.parent.mkdir(parents=True, exist_ok=True)
    reset_path(path_obj)
    safe_symlink(path_obj, target)

def parse_store_version(candidate: Path) -> tuple[int, ...]:
    current = candidate
    store_entry = candidate.parent.parent.name
    while current.parent != current:
        if current.parent.name == ".pnpm":
            store_entry = current.name
            break
        current = current.parent
    match = re.search(r"@(\d+(?:\.\d+){0,3})$", store_entry)
    if not match:
        return (0,)
    return tuple(int(part) for part in match.group(1).split("."))

def is_primary_store_entry(package_name: str, candidate: Path) -> bool:
    current = candidate
    store_entry = candidate.parent.parent.name
    while current.parent != current:
        if current.parent.name == ".pnpm":
            store_entry = current.name
            break
        current = current.parent
    normalized = package_name.replace("/", "+")
    return store_entry.startswith(f"{normalized}@")

def choose_target(package_name: str, spec: str) -> Path | None:
    matches = sorted(store.glob(f"*/node_modules/{package_name}"))
    if not matches:
        return None
    primary_matches = [item for item in matches if is_primary_store_entry(package_name, item)]
    candidates = primary_matches if primary_matches else matches
    filtered = []
    for item in candidates:
        package_json_path = item / "package.json"
        try:
            if not package_json_path.exists():
                continue
            item_payload = json.loads(package_json_path.read_text(encoding="utf-8"))
        except (OSError, Exception):
            continue
        version = str(item_payload.get("version") or "").strip()
        if version and version_satisfies(version, spec):
            filtered.append(item)
    candidates = filtered if filtered else candidates
    candidates.sort(key=lambda item: (parse_store_version(item), str(item)))
    return candidates[-1] if candidates else None

def ensure_store_entry_dependency_link(package_name: str, dependency_name: str, spec: str) -> None:
    package_anchor = store / "node_modules" / package_name
    if not safe_path_exists(package_anchor):
        return
    dependency_target = choose_target(dependency_name, spec)
    resolved_package = safe_resolve(package_anchor)
    resolved_dependency = safe_resolve(dependency_target) if dependency_target is not None else None
    if resolved_package is None or resolved_dependency is None:
        return
    link_path(resolved_package.parents[1] / dependency_name, resolved_dependency)

def read_manifest(package_name: str) -> dict:
    package_path = shared / package_name
    if not safe_path_exists(package_path):
        return {}
    resolved_package = safe_resolve(package_path)
    if resolved_package is None:
        return {}
    package_json_path = resolved_package / "package.json"
    if not safe_path_exists(package_json_path):
        return {}
    try:
        return json.loads(package_json_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def ensure_declared_manifest_links(package_name: str) -> list[str]:
    payload = read_manifest(package_name)
    discovered = []
    if not payload:
        return discovered
    for dependency_group in ("peerDependencies", "dependencies", "optionalDependencies"):
        dependency_map = payload.get(dependency_group) or {}
        if not isinstance(dependency_map, dict):
            continue
        for dependency_name in sorted(dependency_map):
            if isinstance(dependency_name, str) and dependency_name.strip():
                dependency_spec = str(dependency_map.get(dependency_name) or "")
                shared_spec = dependencies.get(dependency_name) or dependency_spec
                dependency_target = choose_target(dependency_name, shared_spec)
                resolved_dependency = safe_resolve(dependency_target) if dependency_target is not None else None
                if resolved_dependency is None:
                    continue
                link_path(shared / dependency_name, resolved_dependency)
                link_path(store / "node_modules" / dependency_name, resolved_dependency)
                package_anchor = store / "node_modules" / package_name
                resolved_package = safe_resolve(package_anchor)
                if resolved_package is not None:
                    link_path(resolved_package.parents[1] / dependency_name, resolved_dependency)
                discovered.append(dependency_name)
    return discovered

all_resolved = True
for package_name, spec in sorted(dependencies.items()):
    target = choose_target(package_name, spec)
    if target is None:
        all_resolved = False
        continue
    resolved_target = safe_resolve(target)
    if resolved_target is None:
        all_resolved = False
        continue
    link_path(shared / package_name, resolved_target)
    link_path(store / "node_modules" / package_name, resolved_target)
    ensure_declared_manifest_links(package_name)

compat_lru_target = choose_target("lru-cache", "^10.4.3")
compat_lru_resolved = safe_resolve(compat_lru_target) if compat_lru_target is not None else None
if compat_lru_resolved is not None:
    link_path(store / "node_modules" / "lru-cache", compat_lru_resolved)
ensure_store_entry_dependency_link("@asamuzakjp/css-color", "lru-cache", "^10.4.3")

compat_dequal_target = choose_target("dequal", "^2.0.3")
compat_dequal_resolved = safe_resolve(compat_dequal_target) if compat_dequal_target is not None else None
if compat_dequal_resolved is not None:
    # Preserve-symlink consumers like aria-query can walk parent chains through
    # workspace symlink paths, so they need a shared-root dequal anchor too.
    link_path(shared / "dequal", compat_dequal_resolved)
    link_path(store / "node_modules" / "dequal", compat_dequal_resolved)

raise SystemExit(0 if all_resolved else 1)
PY
}

uiq_shared_link_repair_verdict() {
  local repair_output="${1:-}"
  if [[ -z "$repair_output" ]]; then
    printf '%s\n' "ok"
    return 0
  fi
  if [[ "$repair_output" == *"error:"* ]]; then
    printf '%s\n' "hard-fail"
    return 0
  fi
  printf '%s\n' "degradable-gap"
}

uiq_capture_shared_link_repair() {
  local root_dir="$1"
  local output_var_name="$2"
  local verdict_var_name="${3:-}"
  local repair_output=""
  local repair_rc=0

  set +e
  repair_output="$(uiq_repair_shared_module_links "$root_dir" 2>&1)"
  repair_rc=$?
  set -e

  printf -v "$output_var_name" '%s' "$repair_output"
  if [[ -n "$verdict_var_name" ]]; then
    printf -v "$verdict_var_name" '%s' "$(uiq_shared_link_repair_verdict "$repair_output")"
  fi

  return "$repair_rc"
}

uiq_container_gate_root_resolution_targets_ready() {
  local shared_dir="$1"
  python3 - "$shared_dir" <<'PY'
from pathlib import Path
import sys

shared = Path(sys.argv[1])
required = [
    "@playwright/test/package.json",
    "@playwright/experimental-ct-react/package.json",
    "@playwright/experimental-ct-core/package.json",
]

for rel_path in required:
    if not (shared / rel_path).exists():
        raise SystemExit(1)
raise SystemExit(0)
PY
}

uiq_repair_shared_module_links() {
  local root_dir="$1"
  case "${UIQ_SKIP_SHARED_MODULE_LINK_REPAIR:-0}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
  esac
  local shared_dir="${UIQ_NODE_MODULES_DIR:-$(uiq_resolve_node_modules_dir "$root_dir")}"
  mkdir -p "$shared_dir" "${shared_dir}/.pnpm"
  local repair_lock_dir="${shared_dir}/.repair-lock"
  local repair_stamp_file="${shared_dir}/.repair-stamp"
  local waited_seconds=0
  local max_wait_seconds="${UIQ_SHARED_MODULE_REPAIR_LOCK_TIMEOUT_SEC:-120}"
  local repair_fingerprint=""

  while ! mkdir "$repair_lock_dir" 2>/dev/null; do
    if [[ -f "${repair_lock_dir}/pid" ]]; then
      local lock_pid=""
      lock_pid="$(cat "${repair_lock_dir}/pid" 2>/dev/null || true)"
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -rf "$repair_lock_dir"
        continue
      fi
      if (( waited_seconds == 0 || waited_seconds % 5 == 0 )); then
        echo "[shared-link-repair] waiting for repair lock held by pid=${lock_pid:-unknown}" >&2
      fi
    fi
    if (( waited_seconds >= max_wait_seconds )); then
      echo "error: timed out waiting for shared module repair lock at ${repair_lock_dir}" >&2
      return 1
    fi
    sleep 1
    waited_seconds=$((waited_seconds + 1))
  done

  printf '%s\n' "$$" > "${repair_lock_dir}/pid"
  trap 'rm -rf "'"$repair_lock_dir"'"' RETURN
  repair_fingerprint="$(uiq_shared_link_repair_fingerprint "$root_dir")"
  if [[ -f "$repair_stamp_file" ]] && [[ "$(cat "$repair_stamp_file" 2>/dev/null || true)" == "$repair_fingerprint" ]]; then
    if uiq_shared_node_cache_ready_for_shortcut "$root_dir" "$shared_dir"; then
      echo "[shared-link-repair] stamp match detected, but running full topology repair for deterministic shared links" >&2
    fi
    echo "[shared-link-repair] stamp matched but shared cache is incomplete, running full repair" >&2
  fi
  if uiq_dir_has_entries "${shared_dir}/.pnpm" && uiq_refresh_direct_shared_links "$root_dir" "$shared_dir"; then
    echo "[shared-link-repair] direct root-link refresh completed, continuing into full topology repair" >&2
  elif [[ ! -f "$repair_stamp_file" ]] && uiq_shared_node_cache_ready_for_shortcut "$root_dir" "$shared_dir"; then
    echo "[shared-link-repair] cache ready without stamp, but full topology repair is still required" >&2
  fi
  python3 - "$root_dir" "$shared_dir" <<'PY'
from pathlib import Path
import json
import re
import shutil
import sys

root = Path(sys.argv[1])
shared = Path(sys.argv[2])
pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
deps: dict[str, str] = {}
for section in ("dependencies", "devDependencies"):
    dependency_map = pkg.get(section) or {}
    if isinstance(dependency_map, dict):
        for name, spec in dependency_map.items():
            if isinstance(name, str) and name.strip():
                deps[name] = str(spec or "").strip()

store = shared / ".pnpm"
if not store.exists():
    raise SystemExit(0)

def parse_version_tuple(candidate: Path) -> tuple[int, ...]:
    current = candidate
    store_entry = candidate.parent.parent.name
    while current.parent != current:
        if current.parent.name == ".pnpm":
            store_entry = current.name
            break
        current = current.parent
    match = re.search(r"@(\d+(?:\.\d+){0,3})$", store_entry)
    if not match:
        return (0,)
    return tuple(int(part) for part in match.group(1).split("."))

def compare_version(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    max_len = max(len(left), len(right))
    padded_left = left + (0,) * (max_len - len(left))
    padded_right = right + (0,) * (max_len - len(right))
    if padded_left < padded_right:
        return -1
    if padded_left > padded_right:
        return 1
    return 0

def version_matches_spec(version: tuple[int, ...], spec: str | None) -> bool:
    if not spec:
        return True
    spec = spec.strip()
    if not spec:
        return True
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", spec)
    if not match:
        return True
    expected = tuple(int(part) for part in match.groups() if part is not None)
    if not expected:
        return True
    if spec.startswith("^"):
        return (
            len(version) >= 1
            and version[0] == expected[0]
            and compare_version(version, expected) >= 0
        )
    if spec.startswith("~"):
        return (
            len(version) >= 2
            and version[:2] == expected[:2]
            and compare_version(version, expected) >= 0
        )
    if spec.startswith(">="):
        return compare_version(version, expected) >= 0
    if spec.startswith(">"):
        return compare_version(version, expected) > 0
    if spec.startswith("<="):
        return compare_version(version, expected) <= 0
    if spec.startswith("<"):
        return compare_version(version, expected) < 0
    return version[:len(expected)] == expected

def is_primary_store_entry(package_name: str, candidate: Path) -> bool:
    current = candidate
    store_entry = candidate.parent.parent.name
    while current.parent != current:
        if current.parent.name == ".pnpm":
            store_entry = current.name
            break
        current = current.parent
    normalized = package_name.replace("/", "+")
    return store_entry.startswith(f"{normalized}@")

def choose_target(package_name: str, version_spec: str | None = None) -> Path | None:
    search = package_name
    matches = sorted(store.glob(f"*/node_modules/{search}"))
    if not matches:
        return None
    filtered_matches = [item for item in matches if version_matches_spec(parse_version_tuple(item), version_spec)]
    primary_filtered_matches = [
        item for item in filtered_matches if is_primary_store_entry(package_name, item)
    ]
    primary_matches = [item for item in matches if is_primary_store_entry(package_name, item)]
    candidates = (
        primary_filtered_matches
        or filtered_matches
        or primary_matches
        or matches
    )
    candidates.sort(key=lambda item: (parse_version_tuple(item), str(item)))
    return candidates[-1]

def safe_resolve(path_obj: Path) -> Path | None:
    try:
        return path_obj.resolve()
    except RuntimeError:
        return None
    except OSError:
        return None

def safe_path_exists(path_obj: Path) -> bool:
    try:
        return path_obj.exists() or path_obj.is_symlink()
    except OSError:
        return False

def safe_is_symlink(path_obj: Path) -> bool:
    try:
        return path_obj.is_symlink()
    except OSError:
        return False

def safe_is_dir(path_obj: Path) -> bool:
    try:
        return path_obj.is_dir()
    except OSError:
        return False

def safe_symlink(path_obj: Path, target: Path) -> None:
    last_error: FileExistsError | None = None
    for _ in range(3):
        try:
            path_obj.symlink_to(target)
            return
        except FileExistsError as exc:
            last_error = exc
            resolved_existing = safe_resolve(path_obj)
            resolved_target = safe_resolve(target)
            if resolved_existing is not None and resolved_target is not None and resolved_existing == resolved_target:
                return
            if safe_is_dir(path_obj) and not safe_is_symlink(path_obj):
                shutil.rmtree(path_obj)
            else:
                path_obj.unlink(missing_ok=True)
    if last_error is not None:
        raise last_error

def remove_existing_path(path_obj: Path) -> None:
    try:
        if safe_is_symlink(path_obj):
            path_obj.unlink(missing_ok=True)
            return
        if safe_is_dir(path_obj):
            shutil.rmtree(path_obj)
            return
        path_obj.unlink(missing_ok=True)
    except FileNotFoundError:
        return
    except OSError as exc:
        if "symbolic link" in str(exc):
            path_obj.unlink(missing_ok=True)
            return
        raise

def ensure_link(package_name: str, version_spec: str | None = None) -> None:
    package_path = shared / package_name
    target = choose_target(package_name, version_spec)
    if target is None:
        return
    package_path.parent.mkdir(parents=True, exist_ok=True)
    if safe_path_exists(package_path):
        remove_existing_path(package_path)
    resolved_target = safe_resolve(target)
    if resolved_target is None:
        return
    safe_symlink(package_path, resolved_target)

def ensure_anchor_link(package_name: str, version_spec: str | None = None) -> None:
    anchor_path = store / "node_modules" / package_name
    target = choose_target(package_name, version_spec)
    if target is None:
        return
    anchor_path.parent.mkdir(parents=True, exist_ok=True)
    if safe_path_exists(anchor_path):
        remove_existing_path(anchor_path)
    resolved_target = safe_resolve(target)
    if resolved_target is None:
        return
    safe_symlink(anchor_path, resolved_target)

def ensure_dependency_link(package_name: str, dependency_name: str, version_spec: str | None = None) -> None:
    package_path = shared / package_name
    dependency_target = choose_target(dependency_name, version_spec)
    if not safe_path_exists(package_path) or dependency_target is None:
        return
    anchor_candidates = []
    resolved_shared_package = safe_resolve(package_path)
    if resolved_shared_package is not None:
        anchor_candidates.append(resolved_shared_package.parents[1] / dependency_name)
    package_anchor = store / "node_modules" / package_name
    resolved_store_package = safe_resolve(package_anchor)
    if resolved_store_package is not None:
        anchor_candidates.append(resolved_store_package.parents[1] / dependency_name)
    resolved_dependency_target = safe_resolve(dependency_target)
    if resolved_dependency_target is None:
        return
    seen_anchor_paths: set[str] = set()
    for dependency_anchor in anchor_candidates:
        anchor_key = str(dependency_anchor)
        if anchor_key in seen_anchor_paths:
            continue
        seen_anchor_paths.add(anchor_key)
        dependency_anchor.parent.mkdir(parents=True, exist_ok=True)
        if safe_path_exists(dependency_anchor):
            remove_existing_path(dependency_anchor)
        safe_symlink(dependency_anchor, resolved_dependency_target)

def read_manifest(package_name: str) -> dict:
    package_path = shared / package_name
    if not safe_path_exists(package_path):
        return {}
    resolved_package = safe_resolve(package_path)
    if resolved_package is None:
        return {}
    package_json = resolved_package / "package.json"
    if not safe_path_exists(package_json):
        return {}
    try:
        return json.loads(package_json.read_text(encoding="utf-8"))
    except Exception:
        return {}

def ensure_declared_manifest_links(package_name: str) -> list[str]:
    payload = read_manifest(package_name)
    discovered = []
    if not payload:
        return discovered
    for dependency_group in ("peerDependencies", "dependencies", "optionalDependencies"):
        dependency_map = payload.get(dependency_group) or {}
        if not isinstance(dependency_map, dict):
            continue
        for dependency_name in sorted(dependency_map):
            if isinstance(dependency_name, str) and dependency_name.strip():
                dependency_spec = str(dependency_map.get(dependency_name) or "")
                shared_spec = deps.get(dependency_name) or dependency_spec
                ensure_link(dependency_name, shared_spec)
                ensure_anchor_link(dependency_name, shared_spec)
                ensure_dependency_link(package_name, dependency_name, dependency_spec)
                discovered.append(dependency_name)
    return discovered

def iter_anchor_packages() -> list[str]:
    anchors = []
    anchor_root = store / "node_modules"
    if not anchor_root.exists():
        return anchors
    for entry in sorted(anchor_root.iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.name.startswith("@"):
            for child in sorted(entry.iterdir()):
                anchors.append(f"{entry.name}/{child.name}")
        else:
            anchors.append(entry.name)
    return anchors

def ensure_store_entry_dependency_link(
    package_name: str, dependency_name: str, version_spec: str | None = None
) -> None:
    package_anchor = store / "node_modules" / package_name
    if not package_anchor.exists():
        return
    dependency_target = choose_target(dependency_name, version_spec)
    if dependency_target is None:
        return
    resolved = safe_resolve(package_anchor)
    resolved_dependency_target = safe_resolve(dependency_target)
    if resolved is None or resolved_dependency_target is None:
        return
    dependency_anchor = resolved.parents[1] / dependency_name
    dependency_anchor.parent.mkdir(parents=True, exist_ok=True)
    if dependency_anchor.exists() or dependency_anchor.is_symlink():
        remove_existing_path(dependency_anchor)
    safe_symlink(dependency_anchor, resolved_dependency_target)

queue = sorted(set(deps))
initial_total = len(queue)
if initial_total > 0:
    print(f"[shared-link-repair] packages queued: {initial_total}", flush=True)
seen = set()
processed = 0
max_observed_total = initial_total
while queue:
    dep = queue.pop(0)
    if dep in seen:
        continue
    seen.add(dep)
    processed += 1
    current_total = processed + len(queue)
    if current_total > max_observed_total:
        max_observed_total = current_total
    if processed == 1 or processed % 100 == 0 or processed == max_observed_total:
        print(f"[shared-link-repair] progress {processed}/{max_observed_total}", flush=True)
    direct_spec = deps.get(dep)
    ensure_link(dep, direct_spec)
    ensure_anchor_link(dep, direct_spec)
    for child in ensure_declared_manifest_links(dep):
        if child not in seen:
            queue.append(child)
ensure_store_entry_dependency_link("@stryker-mutator/core", "ajv")
ensure_store_entry_dependency_link("@stryker-mutator/typescript-checker", "ajv")
ensure_store_entry_dependency_link("@asamuzakjp/css-color", "lru-cache", "^10.4.3")
ensure_store_entry_dependency_link("aria-query", "dequal", "^2.0.3")
ensure_link("dequal", "^2.0.3")
ensure_anchor_link("lru-cache", "^10.4.3")
ensure_anchor_link("dequal", "^2.0.3")
PY
  if uiq_dir_has_entries "${shared_dir}/.pnpm"; then
    uiq_refresh_direct_shared_links "$root_dir" "$shared_dir"
  fi
  mkdir -p "$shared_dir" "${shared_dir}/.pnpm"
  printf '%s\n' "$repair_fingerprint" > "$repair_stamp_file"
  uiq_link_workspace_node_modules "$root_dir"
}

uiq_rematerialize_authoritative_workspace_node_modules() {
  local root_dir="$1"
  local caller_label="${2:-node-toolchain}"
  echo "[${caller_label}] host install state drift detected; rematerializing repo-local authoritative node_modules" >&2
  env -u RUNNER_TEMP \
    UIQ_NODE_MODULES_DIR="$root_dir/node_modules" \
    bash "$root_dir/scripts/ci/pnpm-install-safe.sh" --frozen-lockfile
  unset RUNNER_TEMP || true
  export UIQ_NODE_MODULES_DIR="$root_dir/node_modules"
  uiq_export_node_env "$root_dir"
}
