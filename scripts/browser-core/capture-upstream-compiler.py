#!/usr/bin/env python3
"""Capture the source/header bytes named by a compiler's dependency output."""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import uuid


def retain_input(path, root):
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    snapshot = root / "inputs" / digest
    temporary = snapshot.parent / (".staging-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as target:
            target.write(data)
        try:
            os.link(temporary, snapshot)
        except FileExistsError:
            # Every writer publishes a complete snapshot under its content hash.
            pass
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "path": str(path),
        "sha256": digest,
        "sizeBytes": len(data),
        "retainedSnapshotPath": str(snapshot.relative_to(root)),
    }


def capture(arguments):
    root = Path(os.environ["ECS_COMPILE_CAPTURE"]).resolve()
    for directory in (root, root / "commands", root / "inputs"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    identifier = uuid.uuid4().hex
    dependency = root / (".dependencies-" + identifier + ".d")
    command = list(arguments)
    if "-c" in command:
        command.extend(["-MD", "-MF", str(dependency)])
    compiler = shutil.which(command[0]) or command[0]
    record = {
        "cwd": os.getcwd(),
        "compilerPath": str(Path(compiler).resolve()),
        "args": command,
        "exitCode": None,
        "wrapperExitCode": None,
        "inputCaptureTiming": "immediately-after-compiler-exit",
        "inputFiles": [],
    }
    try:
        result = subprocess.run(command)
        record["exitCode"] = result.returncode
        record["wrapperExitCode"] = result.returncode
        output = None
        if "-o" in command:
            output = (Path.cwd() / command[command.index("-o") + 1]).resolve()
            if output.is_file():
                with output.open("rb") as product:
                    digest = hashlib.file_digest(product, "sha256").hexdigest()
                record["outputObject"] = {
                    "path": str(output),
                    "sha256": digest,
                    "sizeBytes": output.stat().st_size,
                }
        if dependency.exists():
            data = dependency.read_bytes()
            record["dependencyOutput"] = {
                "sha256": hashlib.sha256(data).hexdigest(),
                "sizeBytes": len(data),
            }
            # Join the main Make rule's continuations.
            # Optional -MP phony rules do not add compiler inputs.
            rule = data.decode().replace("\\\n", " ").splitlines()[0]
            names = shlex.split(rule.split(":", 1)[1])
            paths = sorted({(Path.cwd() / name).resolve() for name in names})
            for path in paths:
                if path == output or path.suffix.lower() in {
                    ".o",
                    ".obj",
                    ".a",
                    ".lib",
                    ".bc",
                    ".wasm",
                    ".so",
                    ".dylib",
                    ".dll",
                }:
                    raise RuntimeError(
                        "A compiler output appeared in its source dependency list"
                    )
                record["inputFiles"].append(retain_input(path, root))
        elif "-c" in command and result.returncode == 0:
            raise RuntimeError(
                "Successful compilation did not produce source dependencies"
            )
    except Exception as error:
        record["captureError"] = str(error)
        record["wrapperExitCode"] = 1
        print("Compiler input capture failed. " + str(error), file=sys.stderr)
    finally:
        dependency.unlink(missing_ok=True)
        temporary = root / "commands" / (".staging-" + identifier)
        destination = root / "commands" / (identifier + ".json")
        with temporary.open("x") as target:
            json.dump(record, target, indent=2)
            target.write("\n")
        temporary.rename(destination)
    return record["wrapperExitCode"]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("A compiler command is required")
    sys.exit(capture(sys.argv[1:]))
