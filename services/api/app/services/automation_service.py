from __future__ import annotations

from app.core.settings import env_str

import hashlib
import json
import os
import re
import subprocess
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock, Semaphore, Thread
from typing import Literal
from uuid import uuid4

from fastapi import HTTPException, status

from app.core.metrics import runtime_metrics
from app.core.task_store import build_task_store
from app.models.automation import CommandDefinition, TaskSnapshot, TaskStatus
from app.services.automation_commands import (
    CommandSpec,
    build_command_specs,
    is_high_risk_automation_command,
    is_safe_automation_command,
)

logger = logging.getLogger("automation")


@dataclass
class RunningTask:
    task_id: str
    command_id: str
    status: TaskStatus
    created_at: datetime
    requested_by: str | None = None
    attempt: int = 1
    max_attempts: int = 1
    started_at: datetime | None = None
    finished_at: datetime | None = None
    exit_code: int | None = None
    message: str | None = None
    output_lines: list[str] = field(default_factory=list)
    process: subprocess.Popen[str] | None = None
    idempotency_key: str | None = None
    replay_of_task_id: str | None = None

    def snapshot(self) -> TaskSnapshot:
        tail = "".join(self.output_lines[-200:])
        updated_at = self.finished_at or self.started_at or self.created_at
        return TaskSnapshot(
            task_id=self.task_id,
            command=self.command_id,
            command_id=self.command_id,
            status=self.status,
            requested_by=self.requested_by,
            attempt=self.attempt,
            max_attempts=self.max_attempts,
            created_at=self.created_at,
            updated_at=updated_at,
            started_at=self.started_at,
            finished_at=self.finished_at,
            exit_code=self.exit_code,
            message=self.message,
            output_tail=tail,
        )


class AutomationService:
    _CONTROL_ENV_KEYS = frozenset({"AUTOMATION_IDEMPOTENCY_KEY", "AUTOMATION_IDEMPOTENCY_REPLAY"})

    def __init__(self) -> None:
        # .../services/api/app/services -> repo root
        self._root = Path(__file__).resolve().parents[4]
        self._lock = Lock()
        self._tasks: dict[str, RunningTask] = {}
        self._max_tasks = int(env_str("AUTOMATION_MAX_TASKS", "200"))
        self._max_parallel = max(1, int(env_str("AUTOMATION_MAX_PARALLEL", "6")))
        self._max_parallel_long = max(1, int(env_str("AUTOMATION_MAX_PARALLEL_LONG", "1")))
        self._default_retries = max(0, int(env_str("AUTOMATION_DEFAULT_RETRIES", "0")))
        self._retry_base_seconds = max(0.1, float(env_str("AUTOMATION_RETRY_BASE_SECONDS", "1.0")))
        self._retry_max_seconds = max(
            self._retry_base_seconds, float(env_str("AUTOMATION_RETRY_MAX_SECONDS", "30.0"))
        )
        self._retry_jitter_ratio = min(
            1.0, max(0.0, float(env_str("AUTOMATION_RETRY_JITTER_RATIO", "0.2")))
        )
        self._command_timeout_seconds = max(
            30, int(env_str("AUTOMATION_COMMAND_TIMEOUT_SECONDS", "1800"))
        )
        self._completed_task_ttl_seconds = max(
            60, int(env_str("AUTOMATION_COMPLETED_TASK_TTL_SECONDS", "86400"))
        )
        self._idempotency_ttl_seconds = max(
            60, int(env_str("AUTOMATION_IDEMPOTENCY_TTL_SECONDS", "21600"))
        )
        self._max_output_lines = 2000
        self._slot_limiter = Semaphore(self._max_parallel)
        self._long_slot_limiter = Semaphore(self._max_parallel_long)
        self._task_store = build_task_store(self._root)
        self._idempotency_records: dict[str, tuple[str, datetime]] = {}
        self._redaction_patterns = [
            re.compile(r"(x-automation-token\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(authorization\s*[:=]\s*bearer\s+)([^\s]+)", re.IGNORECASE),
            re.compile(r"(gemini_api_key\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(google_api_key\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(password\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(stripecardnumber\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(stripeexpmonth\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(stripeexpyear\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(stripecvc\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(stripecardholdername\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(stripepostalcode\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
            re.compile(r"(stripecountry\s*[:=]\s*)([^\s]+)", re.IGNORECASE),
        ]
        self._allowed_env = {
            "BASE_URL",
            "START_URL",
            "SUCCESS_SELECTOR",
            "AI_PROVIDER",
            "AI_SPEED_MODE",
            "VIDEO_ANALYZER_PROVIDER",
            "MIDSCENE_MODEL_NAME",
            "GEMINI_API_KEY",
            "GEMINI_MODEL",
            "GEMINI_FAST_MODEL",
            "GEMINI_EMBEDDING_MODEL",
            "GEMINI_THINKING_LEVEL",
            "GEMINI_MODEL",
            "GEMINI_FALLBACK_MODELS",
            "MIDSCENE_STRICT",
            "REGISTER_PASSWORD",
            "HEADLESS",
            "FLOW_STEP_ID",
            "FLOW_FROM_STEP_ID",
            "FLOW_REPLAY_PRECONDITIONS",
            "FLOW_SELECTOR_INDEX",
            "FLOW_INPUT",
            "FLOW_SECRET_INPUT",
            "FLOW_OTP_CODE",
            "AUTOMATION_IDEMPOTENCY_KEY",
            "AUTOMATION_IDEMPOTENCY_REPLAY",
            "stripeCardNumber",
            "stripeExpMonth",
            "stripeExpYear",
            "stripeCvc",
            "stripeCardholderName",
            "stripePostalCode",
            "stripeCountry",
        }
        self._commands: dict[str, CommandSpec] = build_command_specs()
        self._deprecated_env_hits = 0
        self._load_state()

    def list_commands(self) -> list[CommandDefinition]:
        return [
            CommandDefinition(
                command_id=spec.command_id,
                title=spec.title,
                description=spec.description,
                tags=spec.tags,
                accepts_env=True,
            )
            for spec in self._commands.values()
        ]

    def storage_backend(self) -> str:
        return self._task_store.kind

    def task_summary(self) -> dict[str, int]:
        if self._task_store.kind == "sql":
            summary = self._task_store.summary()
            summary["deprecated_env_hits"] = self._deprecated_env_hits
            return summary
        with self._lock:
            counts = {"queued": 0, "running": 0, "success": 0, "failed": 0, "cancelled": 0}
            completed = 0
            failed = 0
            for task in self._tasks.values():
                counts[task.status] += 1
                if task.status in {"success", "failed", "cancelled"}:
                    completed += 1
                if task.status == "failed":
                    failed += 1
            return {
                "total": len(self._tasks),
                "queued": counts["queued"],
                "running": counts["running"],
                "success": counts["success"],
                "failed": counts["failed"],
                "cancelled": counts["cancelled"],
                "completed": completed,
                "failed_completed": failed,
                "deprecated_env_hits": self._deprecated_env_hits,
            }

    def list_tasks(
        self,
        *,
        status: TaskStatus | None = None,
        command_id: str | None = None,
        limit: int = 100,
        requested_by: str | None = None,
    ) -> list[TaskSnapshot]:
        with self._lock:
            self._sync_from_store_locked()
            tasks = [task.snapshot() for task in self._tasks.values()]
        filtered = tasks
        if requested_by:
            filtered = [task for task in filtered if task.requested_by == requested_by]
        if status:
            filtered = [task for task in filtered if task.status == status]
        if command_id:
            filtered = [task for task in filtered if task.command_id == command_id]
        sorted_tasks = sorted(filtered, key=lambda item: item.created_at, reverse=True)
        safe_limit = max(1, min(limit, 500))
        return sorted_tasks[:safe_limit]

    def get_task(self, task_id: str, requested_by: str | None = None) -> TaskSnapshot:
        with self._lock:
            self._sync_from_store_locked()
            task = self._tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")
        if requested_by and task.requested_by and task.requested_by != requested_by:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="task access denied")
        return task.snapshot()

    def run_command(
        self,
        command_id: str,
        env_overrides: dict[str, str],
        *,
        used_deprecated_env: bool = False,
        requested_by: str | None = None,
    ) -> TaskSnapshot:
        spec = self._commands.get(command_id)
        if not spec:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="command not found")
        if not is_safe_automation_command(command_id):
            reason = (
                "high-risk command is disabled for remote execution"
                if is_high_risk_automation_command(command_id)
                else "command is not allowlisted"
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"{reason}: {command_id}",
            )

        filtered_env = self._filter_env(env_overrides)
        replay_requested = self._is_replay_requested(filtered_env)
        child_env = self._without_control_env(filtered_env)
        idempotency_key = self._resolve_idempotency_key(
            command_id, child_env, requested_by, filtered_env
        )
        if used_deprecated_env:
            logger.warning(
                "deprecated automation run env payload used",
                extra={
                    "command_id": command_id,
                    "requested_by": self._mask_requester(requested_by),
                },
            )
        replay_of_task_id: str | None = None
        with self._lock:
            if used_deprecated_env:
                self._deprecated_env_hits += 1
            existing_task = self._find_task_by_idempotency_key_locked(idempotency_key)
            if existing_task is not None:
                if existing_task.status in {"queued", "running"}:
                    return existing_task.snapshot()
                if not replay_requested:
                    return existing_task.snapshot()
                replay_of_task_id = existing_task.task_id
            self._prune_tasks_locked(additional_slots=1)
            if len(self._tasks) >= self._max_tasks:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="automation queue is full, try later",
                )
            task_id = (
                str(uuid4())
                if replay_of_task_id
                else self._task_id_for_idempotency_key(idempotency_key)
            )
            task = RunningTask(
                task_id=task_id,
                command_id=command_id,
                status="queued",
                requested_by=requested_by,
                attempt=1,
                max_attempts=self._default_retries + 1,
                created_at=datetime.now(timezone.utc),
                idempotency_key=idempotency_key,
                replay_of_task_id=replay_of_task_id,
            )
            if replay_of_task_id:
                task.message = f"idempotent replay of {replay_of_task_id}"
            self._tasks[task.task_id] = task
            self._idempotency_records[idempotency_key] = (task.task_id, datetime.now(timezone.utc))
            self._save_task_locked(task)

        worker = Thread(target=self._run_task, args=(task.task_id, spec, child_env), daemon=True)
        worker.start()
        runtime_metrics.record_automation_run()
        return task.snapshot()

    def cancel_task(self, task_id: str, requested_by: str | None = None) -> TaskSnapshot:
        with self._lock:
            self._sync_from_store_locked()
            task = self._tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")
        if requested_by and task.requested_by and task.requested_by != requested_by:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="task access denied")

        process = task.process
        if task.status == "queued":
            with self._lock:
                task.status = "cancelled"
                task.finished_at = datetime.now(timezone.utc)
                task.message = "task cancelled before start"
                self._save_task_locked(task)
            runtime_metrics.record_automation_cancellation()
        elif task.status == "running":
            with self._lock:
                task.status = "cancelled"
                task.finished_at = datetime.now(timezone.utc)
                task.message = "task cancellation requested by user"
                self._save_task_locked(task)
            runtime_metrics.record_automation_cancellation()
            if process is not None:
                force_killed = self._terminate_process(process)
                if force_killed:
                    with self._lock:
                        task.message = "task force-killed by user"
                        self._save_task_locked(task)
        return task.snapshot()

    def _filter_env(self, env_overrides: dict[str, str]) -> dict[str, str]:
        clean: dict[str, str] = {}
        for key, value in env_overrides.items():
            if key in self._allowed_env:
                clean[key] = value
        return clean

    def _run_task(self, task_id: str, spec: CommandSpec, env_overrides: dict[str, str]) -> None:
        slot_limiter = (
            self._long_slot_limiter if "long-running" in spec.tags else self._slot_limiter
        )
        with slot_limiter:
            with self._lock:
                task = self._tasks.get(task_id)
                if task is None or task.status == "cancelled":
                    return
                task.status = "running"
                task.started_at = datetime.now(timezone.utc)
                task.message = "running"
                self._save_task_locked(task)

            env = self._build_child_env(env_overrides)
            try:
                with self._lock:
                    if task.status == "cancelled":
                        return
                process = self._spawn_process(spec.argv, env)
            except Exception as exc:  # pragma: no cover - defensive guard
                logger.exception(
                    "automation task spawn failed",
                    extra={
                        "task_id": task.task_id,
                        "command_id": task.command_id,
                        "error": str(exc),
                    },
                )
                with self._lock:
                    task.status = "failed"
                    task.finished_at = datetime.now(timezone.utc)
                    task.message = f"spawn failed: {exc}"
                    self._save_task_locked(task)
                    runtime_metrics.record_automation_failure()
                return

            with self._lock:
                task.process = process
                if task.status == "cancelled":
                    self._terminate_process(process)
                self._save_task_locked(task)

            timeout_watchdog = Thread(
                target=self._enforce_timeout,
                args=(task.task_id, process, self._command_timeout_seconds),
                daemon=True,
            )
            timeout_watchdog.start()

            try:
                if process.stdout is None:
                    raise RuntimeError("process stdout is not available")
                try:
                    for line in process.stdout:
                        with self._lock:
                            task.output_lines.append(self._redact_sensitive(line))
                            if len(task.output_lines) > self._max_output_lines:
                                # Keep bounded memory while preserving recent logs for UI.
                                task.output_lines = task.output_lines[-self._max_output_lines :]
                finally:
                    # Always close the pipe to release the file descriptor regardless
                    # of how the loop exits (normal completion, exception, cancellation).
                    # Guard with hasattr for test stubs that use plain iterators.
                    if hasattr(process.stdout, "close"):
                        process.stdout.close()

                exit_code = process.wait()
                run_retry_inline = False
                with self._lock:
                    task.exit_code = exit_code
                    task.finished_at = datetime.now(timezone.utc)
                    task.process = None
                    if task.status == "cancelled":
                        self._save_task_locked(task)
                        return
                    if exit_code == 0:
                        task.status = "success"
                        task.message = "completed"
                        self._save_task_locked(task)
                        return
                    if task.attempt < task.max_attempts:
                        task.attempt += 1
                        retry_delay_seconds = self._compute_retry_delay_seconds(task.attempt)
                        task.status = "queued"
                        task.message = (
                            f"retrying after exit code {exit_code} in {retry_delay_seconds:.2f}s "
                            f"(attempt {task.attempt}/{task.max_attempts})"
                        )
                        task.started_at = None
                        task.finished_at = None
                        task.process = None
                        self._save_task_locked(task)
                        if retry_delay_seconds <= 0:
                            # Avoid daemon-thread scheduling flakes when retry delay is zero.
                            # This path is mainly used in tests where deterministic retry
                            # execution is preferred over asynchronous dispatch.
                            run_retry_inline = True
                        else:
                            retry_worker = Thread(
                                target=self._retry_task_after_delay,
                                args=(task_id, spec, env_overrides, retry_delay_seconds),
                                daemon=True,
                            )
                            retry_worker.start()
                if run_retry_inline:
                    self._retry_task_after_delay(task_id, spec, env_overrides, 0.0)
                    return
                with self._lock:
                    task_for_failure = self._tasks.get(task_id)
                    if task_for_failure is None:
                        return
                    if task_for_failure.status == "queued":
                        return
                    task_for_failure.status = "failed"
                    task_for_failure.message = f"exit code {exit_code}"
                    self._save_task_locked(task_for_failure)
                    runtime_metrics.record_automation_failure()
            except Exception as exc:  # pragma: no cover - defensive guard
                with self._lock:
                    task_for_exception = self._tasks.get(task_id)
                logger.exception(
                    "automation task runtime failed",
                    extra={
                        "task_id": task_for_exception.task_id if task_for_exception else task_id,
                        "command_id": (
                            task_for_exception.command_id if task_for_exception else spec.command_id
                        ),
                        "error": str(exc),
                    },
                )
                with self._lock:
                    task_for_exception = self._tasks.get(task_id)
                    if task_for_exception is None:
                        return
                    task_for_exception.status = "failed"
                    task_for_exception.finished_at = datetime.now(timezone.utc)
                    task_for_exception.process = None
                    task_for_exception.message = f"runtime failed: {exc}"
                    self._save_task_locked(task_for_exception)
                runtime_metrics.record_automation_failure()

    def _prune_tasks_locked(self, additional_slots: int = 0) -> None:
        now = datetime.now(timezone.utc)
        expired_task_ids = [
            task.task_id
            for task in self._tasks.values()
            if task.status in {"success", "failed", "cancelled"}
            and task.finished_at is not None
            and (now - task.finished_at).total_seconds() > self._completed_task_ttl_seconds
        ]
        for task_id in expired_task_ids:
            self._drop_task_locked(task_id)

        target_size = self._max_tasks - max(0, additional_slots)
        if len(self._tasks) <= target_size:
            self._gc_idempotency_records_locked(now=now)
            return

        overflow = len(self._tasks) - target_size
        candidates = sorted(
            (
                task
                for task in self._tasks.values()
                if task.status in {"success", "failed", "cancelled"}
            ),
            key=lambda item: item.created_at,
        )
        for task in candidates[:overflow]:
            self._drop_task_locked(task.task_id)
        self._gc_idempotency_records_locked(now=now)

    def _spawn_process(self, argv: list[str], env: dict[str, str]) -> subprocess.Popen[str]:
        return subprocess.Popen(
            argv,
            cwd=str(self._root),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

    @staticmethod
    def _owned_child_pid(process: subprocess.Popen[str]) -> int | None:
        pid = process.pid
        if isinstance(pid, int) and pid > 0:
            return pid
        return None

    def _enforce_timeout(
        self, task_id: str, process: subprocess.Popen[str], timeout_seconds: int
    ) -> None:
        deadline = datetime.now(timezone.utc).timestamp() + timeout_seconds
        while process.poll() is None:
            if datetime.now(timezone.utc).timestamp() >= deadline:
                force_killed = self._terminate_process(process)
                with self._lock:
                    task = self._tasks.get(task_id)
                    if task and task.status == "running":
                        task.status = "failed"
                        task.finished_at = datetime.now(timezone.utc)
                        suffix = " (force-killed)" if force_killed else ""
                        task.message = f"timeout after {timeout_seconds}s{suffix}"
                        self._save_task_locked(task)
                        runtime_metrics.record_automation_failure()
                return
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                continue

    @staticmethod
    def _sleep(delay_seconds: float) -> None:
        time.sleep(delay_seconds)

    def _retry_task_after_delay(
        self,
        task_id: str,
        spec: CommandSpec,
        env_overrides: dict[str, str],
        delay_seconds: float,
    ) -> None:
        self._sleep(delay_seconds)
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.status != "queued":
                return
        self._run_task(task_id, spec, env_overrides)

    def _compute_retry_delay_seconds(self, attempt: int) -> float:
        if attempt <= 1:
            return 0.0
        exponent = max(0, attempt - 2)
        base_delay = min(self._retry_max_seconds, self._retry_base_seconds * (2**exponent))
        jitter_span = base_delay * self._retry_jitter_ratio
        if jitter_span <= 0:
            return base_delay
        jitter = random.uniform(-jitter_span, jitter_span)
        return max(0.0, base_delay + jitter)

    def _terminate_process(
        self, process: subprocess.Popen[str], timeout_seconds: float = 3.0
    ) -> bool:
        """Try terminate first, then force kill if the child does not exit."""
        pid = self._owned_child_pid(process)
        if pid is None:
            logger.warning(
                "refused to signal process without owned positive pid",
                extra={"pid": process.pid},
            )
            return False
        if process.poll() is not None:
            return False
        try:
            try:
                process.terminate()
            except ProcessLookupError:
                return False
            except OSError as error:
                logger.warning(
                    "failed to send SIGTERM to process",
                    extra={"error": str(error), "pid": pid},
                )
                return False
            process.wait(timeout=timeout_seconds)
            return False
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except ProcessLookupError:
                return False
            except OSError as error:
                logger.warning(
                    "failed to send SIGKILL to process",
                    extra={"error": str(error), "pid": pid},
                )
                return False
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                logger.warning("process did not exit after kill", extra={"error": "kill timeout"})
            return True

    def _build_child_env(self, env_overrides: dict[str, str]) -> dict[str, str]:
        safe_baseline_keys = {
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "PYTHONUNBUFFERED",
            "TERM",
        }
        env: dict[str, str] = {
            key: value for key, value in os.environ.items() if key in safe_baseline_keys
        }
        env.update(env_overrides)
        return env

    @staticmethod
    def _mask_requester(requested_by: str | None) -> str:
        if not requested_by:
            return "anonymous"
        if len(requested_by) <= 8:
            return requested_by
        return f"{requested_by[:4]}...{requested_by[-2:]}"

    def _save_task_locked(self, task: RunningTask) -> None:
        self._task_store.upsert(task.snapshot())

    def _delete_task_locked(self, task_id: str) -> None:
        self._task_store.delete(task_id)

    def _drop_task_locked(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)
        self._delete_task_locked(task_id)
        for key, (mapped_task_id, _seen_at) in list(self._idempotency_records.items()):
            if mapped_task_id == task_id:
                self._idempotency_records.pop(key, None)

    def _is_replay_requested(self, env_overrides: dict[str, str]) -> bool:
        raw = env_overrides.get("AUTOMATION_IDEMPOTENCY_REPLAY", "")
        return raw.strip().lower() in {"1", "true", "yes", "on", "replay"}

    def _without_control_env(self, env_overrides: dict[str, str]) -> dict[str, str]:
        return {
            key: value for key, value in env_overrides.items() if key not in self._CONTROL_ENV_KEYS
        }

    def _resolve_idempotency_key(
        self,
        command_id: str,
        env_overrides: dict[str, str],
        requested_by: str | None,
        raw_env: dict[str, str],
    ) -> str:
        explicit = raw_env.get("AUTOMATION_IDEMPOTENCY_KEY", "").strip()
        if explicit:
            normalized = re.sub(r"[^a-zA-Z0-9._:-]", "-", explicit)[:128]
            requester_scope = hashlib.sha256(
                (requested_by or "anonymous").encode("utf-8")
            ).hexdigest()[:16]
            return f"user:{requester_scope}:{normalized}"
        payload = {
            "command_id": command_id,
            "requested_by": requested_by or "anonymous",
            "env": {key: env_overrides[key] for key in sorted(env_overrides)},
        }
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return f"auto:{digest[:24]}"

    def _find_task_by_idempotency_key_locked(self, idempotency_key: str) -> RunningTask | None:
        self._gc_idempotency_records_locked()
        record = self._idempotency_records.get(idempotency_key)
        if record is not None:
            task_id, _seen_at = record
            task = self._tasks.get(task_id)
            if task is None:
                self._idempotency_records.pop(idempotency_key, None)
                return None
            self._idempotency_records[idempotency_key] = (task_id, datetime.now(timezone.utc))
            return task

        task_id = self._task_id_for_idempotency_key(idempotency_key)
        task = self._tasks.get(task_id)
        if task is None:
            return None
        self._idempotency_records[idempotency_key] = (task_id, datetime.now(timezone.utc))
        return task

    @staticmethod
    def _task_id_for_idempotency_key(idempotency_key: str) -> str:
        digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
        return f"idem-{digest[:32]}"

    def _gc_idempotency_records_locked(self, *, now: datetime | None = None) -> None:
        now = now or datetime.now(timezone.utc)
        ttl_seconds = self._idempotency_ttl_seconds
        for key, (task_id, seen_at) in list(self._idempotency_records.items()):
            if task_id not in self._tasks:
                self._idempotency_records.pop(key, None)
                continue
            if (now - seen_at).total_seconds() > ttl_seconds:
                self._idempotency_records.pop(key, None)

    def _load_state(self) -> None:
        tasks = self._task_store.load()
        with self._lock:
            self._idempotency_records.clear()
            for item in tasks:
                status = item.status
                recovered_status: Literal["success", "failed", "cancelled"] | TaskStatus
                recovered_status = "failed" if status in {"queued", "running"} else status
                message = item.message
                command_id = item.command_id or item.command
                if status in {"queued", "running"}:
                    message = "interrupted by service restart"
                task = RunningTask(
                    task_id=item.task_id,
                    command_id=command_id,
                    status=recovered_status,
                    requested_by=item.requested_by,
                    attempt=item.attempt,
                    max_attempts=item.max_attempts,
                    created_at=item.created_at,
                    started_at=item.started_at,
                    finished_at=item.finished_at
                    if item.finished_at
                    else datetime.now(timezone.utc),
                    exit_code=item.exit_code,
                    message=message,
                    output_lines=[item.output_tail],
                )
                self._tasks[task.task_id] = task
                if status in {"queued", "running"}:
                    # Persist recovered status so summary/read models stay consistent after restart.
                    self._save_task_locked(task)
            self._prune_tasks_locked()

    def _sync_from_store_locked(self) -> None:
        if self._task_store.kind != "sql":
            return
        loaded: dict[str, RunningTask] = {}
        for item in self._task_store.load():
            command_id = item.command_id or item.command
            loaded[item.task_id] = RunningTask(
                task_id=item.task_id,
                command_id=command_id,
                status=item.status,
                requested_by=item.requested_by,
                attempt=item.attempt,
                max_attempts=item.max_attempts,
                created_at=item.created_at,
                started_at=item.started_at,
                finished_at=item.finished_at,
                exit_code=item.exit_code,
                message=item.message,
                output_lines=[item.output_tail],
            )

        # Keep local process handles for currently running tasks owned by this process.
        for task_id, task in self._tasks.items():
            if task.process is not None and task.status in {"queued", "running"}:
                current = loaded.get(task_id)
                if current is None:
                    loaded[task_id] = task
                else:
                    current.process = task.process
                    current.output_lines = task.output_lines
        self._tasks = loaded

    def close(self) -> None:
        self._task_store.close()

    def _redact_sensitive(self, line: str) -> str:
        value = line
        for pattern in self._redaction_patterns:
            value = pattern.sub(r"\1***REDACTED***", value)
        return value


automation_service = AutomationService()
