"""Keeps the gateway's console from ever stalling a request.
On Windows a click in a console with QuickEdit on freezes every write to it until a key is pressed; the gateway turns QuickEdit off at startup,
and the one-line-per-decision log goes through a queue to a listener thread, so even a frozen console cannot block a request thread."""

import logging
import logging.handlers
import os
import queue
import sys

ENABLE_QUICK_EDIT_MODE = 0x0040
ENABLE_EXTENDED_FLAGS = 0x0080   # must stay set, or Windows ignores the change to the QuickEdit bit
STD_INPUT_HANDLE = -10

_listener: logging.handlers.QueueListener | None = None


def quick_edit_off_mode(mode: int) -> int:
    """The console mode with QuickEdit cleared and the extended-flags bit kept set."""
    return (mode | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE


def disable_quick_edit() -> bool:
    """Turn QuickEdit off on this process's console; True when it changed. A no-op off Windows or without a console."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetStdHandle(STD_INPUT_HANDLE)
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False  # stdin is a pipe or a file, not a console
        return bool(kernel32.SetConsoleMode(handle, quick_edit_off_mode(mode.value)))
    except (AttributeError, OSError):
        return False


def decision_logger() -> logging.Logger:
    """The logger for the per-decision line; its records go through a queue to one listener thread that writes stderr.
    Built once per process (tests build many apps)."""
    global _listener
    logger = logging.getLogger("mytopia.decisions")
    if _listener is None:
        records: queue.Queue = queue.Queue()
        logger.addHandler(logging.handlers.QueueHandler(records))
        logger.setLevel(logging.INFO)
        logger.propagate = False  # only our own handler: no root handler may write from the request thread
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(logging.Formatter("%(message)s"))
        _listener = logging.handlers.QueueListener(records, stream)
        _listener.start()
    return logger
