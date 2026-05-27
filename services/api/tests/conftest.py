from __future__ import annotations

import importlib
import os
import pkgutil
import sys
import types
from pathlib import Path


repo_root = Path(__file__).resolve().parents[3]
services_api_root = repo_root / "services" / "api"
if str(services_api_root) not in sys.path:
    sys.path.insert(0, str(services_api_root))
runtime_cache_root = Path(
    os.environ.get("UIQ_RUNTIME_CACHE_ROOT", "").strip() or (repo_root / ".runtime-cache")
).resolve()
runtime_dir = runtime_cache_root / "test-output"
runtime_dir.mkdir(parents=True, exist_ok=True)
worker_id = os.environ.get("PYTEST_XDIST_WORKER", "main")
test_db_path = runtime_dir / f"backend-tests-{worker_id}.sqlite3"
test_universal_runtime_dir = runtime_dir / f"universal-runtime-{worker_id}"
test_universal_runtime_dir.mkdir(parents=True, exist_ok=True)
test_universal_data_dir = test_universal_runtime_dir / "universal"
test_universal_data_dir.mkdir(parents=True, exist_ok=True)
hypothesis_dir = runtime_cache_root / "cache" / "hypothesis"
hypothesis_dir.mkdir(parents=True, exist_ok=True)

os.environ["DATABASE_URL"] = f"sqlite+pysqlite:///{test_db_path}"
os.environ["REDIS_URL"] = ""
os.environ["RUNTIME_ROOT"] = str(runtime_cache_root)
os.environ["UNIVERSAL_AUTOMATION_RUNTIME_DIR"] = str(test_universal_runtime_dir)
os.environ["UNIVERSAL_PLATFORM_DATA_DIR"] = str(test_universal_data_dir)
os.environ["HYPOTHESIS_STORAGE_DIRECTORY"] = str(hypothesis_dir)

app_package = importlib.import_module("app")
backend_package = sys.modules.setdefault("backend", types.ModuleType("backend"))
backend_package.__path__ = [str(services_api_root)]
setattr(backend_package, "app", app_package)
sys.modules.setdefault("backend.app", app_package)
for module_info in pkgutil.walk_packages(app_package.__path__, prefix="app."):
    module = importlib.import_module(module_info.name)
    sys.modules.setdefault(f"backend.{module_info.name}", module)


def pytest_configure(config) -> None:
    invocation_args = [str(item) for item in config.invocation_params.args]
    normalized_targets = {
        arg.split("::", maxsplit=1)[0].strip().rstrip("/")
        for arg in invocation_args
        if arg and not arg.startswith("-")
    }
    is_full_backend_suite = normalized_targets in (set(), {"services/api/tests"})

    # Keep strict global coverage gate for full-suite runs.
    # Focused test selections should not be blocked by project-wide coverage aggregate.
    if not is_full_backend_suite and hasattr(config.option, "cov_fail_under"):
        config.option.cov_fail_under = 0
        cov_plugin = config.pluginmanager.getplugin("_cov")
        if cov_plugin is not None and hasattr(cov_plugin, "options"):
            cov_plugin.options.cov_fail_under = 0
