#!/usr/bin/env python3
"""Apply the observed SDK header debug path, then use the normal input capture."""

import os
from pathlib import Path
import runpy
import sys


def header_prefix_flag(source_prefix, historical_prefix):
    for prefix in (source_prefix, historical_prefix):
        if (
            not prefix
            or not Path(prefix).is_absolute()
            or any(character in prefix for character in ("\0", "\n", "\r"))
        ):
            raise ValueError("An absolute single-line header debug prefix is required")
    if "=" in source_prefix:
        raise ValueError("The source header prefix cannot contain equals")
    return f"-fdebug-prefix-map={source_prefix}={historical_prefix}"


def capture_sdk_compiler(arguments, source_prefix, historical_prefix, delegate=None):
    if not arguments:
        raise ValueError("A compiler command is required")
    command = [
        arguments[0],
        header_prefix_flag(source_prefix, historical_prefix),
        *arguments[1:],
    ]
    if delegate is None:
        helper = Path(__file__).with_name("capture-upstream-compiler.py")
        delegate = runpy.run_path(str(helper))["capture"]
    return delegate(command)


if __name__ == "__main__":
    try:
        result = capture_sdk_compiler(
            sys.argv[1:],
            os.environ["ECS_SDK_CLANG_HEADER_FROM"],
            os.environ["ECS_SDK_CLANG_HEADER_TO"],
        )
    except (KeyError, ValueError) as error:
        sys.exit(f"SDK header debug mapping failed: {error}")
    sys.exit(result)
