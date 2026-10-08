"""Background job runner. AsyncioJobRunner runs jobs as tasks on the server's event loop; a
Celery/ARQ implementation only needs to provide `submit`."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Protocol

log = logging.getLogger("reconai.jobs")


class JobRunner(Protocol):
    def submit(self, name: str, fn: Callable[[], Awaitable[None]]) -> None: ...


class AsyncioJobRunner:
    def __init__(self) -> None:
        self.tasks: dict[str, asyncio.Task] = {}

    def submit(self, name: str, fn: Callable[[], Awaitable[None]]) -> None:
        task = asyncio.get_running_loop().create_task(fn(), name=name)
        self.tasks[name] = task

        def _done(t: asyncio.Task) -> None:
            self.tasks.pop(name, None)
            if not t.cancelled() and t.exception():
                log.error("Job %s crashed: %r", name, t.exception())

        task.add_done_callback(_done)

    async def drain(self) -> None:
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)


_runner: JobRunner = AsyncioJobRunner()


def get_runner() -> JobRunner:
    return _runner


def set_runner(r: JobRunner) -> None:
    global _runner
    _runner = r
