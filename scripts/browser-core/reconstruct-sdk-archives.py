#!/usr/bin/env python3
"""Rebuild pinned SDK system archives from a fresh primary Emscripten source tree."""

import argparse
import datetime
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import platform
import re
import runpy
import subprocess
import sys
import tarfile
import urllib.request


REPOSITORY = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = (
    REPOSITORY / "docs/operations/sdk-archive-reconstruction-plan-2026-11-07.json"
)
CAPTURE_WRAPPER = REPOSITORY / "scripts/browser-core/capture-upstream-compiler.py"
SDK_CAPTURE_ADAPTER = REPOSITORY / "scripts/browser-core/capture-sdk-compiler.py"
HELPERS = runpy.run_path(
    str(REPOSITORY / "scripts/browser-core/reconstruct-vitaquake2.py")
)
file_pin = HELPERS["file_pin"]
capture_summary = HELPERS["capture_summary"]
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024


def parse_ar(data):
    """Read regular ar members, including GNU/BSD long names, without extraction."""
    if not data.startswith(b"!<arch>\n"):
        raise ValueError("A regular ar archive is required")
    offset = 8
    records = []
    long_names = None
    while offset < len(data):
        if offset + 60 > len(data):
            raise ValueError("Truncated ar header")
        header = data[offset : offset + 60]
        if header[58:60] != b"`\n":
            raise ValueError("Invalid ar header terminator")
        size_field = header[48:58].decode("ascii").strip()
        if not size_field.isdigit():
            raise ValueError("Invalid ar member size")
        size = int(size_field)
        start = offset + 60
        end = start + size
        if end > len(data):
            raise ValueError("Truncated ar member")
        payload = data[start:end]
        name = header[:16].decode("ascii").strip()
        if name == "//":
            if long_names is not None:
                raise ValueError("Duplicate GNU ar name table")
            long_names = payload
        else:
            records.append((name, payload))
        offset = end
        if size % 2:
            if data[offset : offset + 1] != b"\n":
                raise ValueError("Missing ar member padding")
            offset += 1
    members = {}
    for name, payload in records:
        if name in ("/", "/SYM64/"):
            continue
        if name.startswith("#1/"):
            length = int(name[3:])
            if length < 1 or length > len(payload):
                raise ValueError("Invalid BSD ar long name")
            name = payload[:length].decode().rstrip("\0")
            payload = payload[length:]
        elif name.startswith("/"):
            if not name[1:].isdigit() or long_names is None:
                raise ValueError("Invalid GNU ar name reference")
            index = int(name[1:])
            if index >= len(long_names) or (index and long_names[index - 1] != 10):
                raise ValueError("Invalid GNU ar name offset")
            end = long_names.find(b"/\n", index)
            if end < 0:
                raise ValueError("Unterminated GNU ar long name")
            name = long_names[index:end].decode()
        else:
            name = name.removesuffix("/")
        if name in ("__.SYMDEF", "__.SYMDEF SORTED", "__.SYMDEF_64"):
            continue
        if not name or name in members:
            raise ValueError("Empty or duplicate ar member name")
        members[name] = payload
    return members


OBJECT_SECTION_SCOPE = (
    "Diagnostic equality of exact serialized WebAssembly v1 section bytes, "
    "including section IDs, length encodings and custom names. Excludes only "
    "custom names beginning .debug_ or reloc..debug_. All other sections, "
    "including linking, reloc.CODE, reloc.DATA, producers and target_features, "
    "remain compared in order. This checks section framing, not instruction "
    "validity, semantic equivalence, archive order equivalence or whole bytes. "
    "Malformed/unsupported objects cannot produce section equality."
)


def fingerprint_wasm_object(data):
    if not data.startswith(b"\0asm"):
        return {"status": "unsupported-non-wasm"}
    if len(data) < 8:
        return {"status": "malformed-wasm-object", "error": "Truncated WASM header"}
    if data[4:8] != b"\x01\0\0\0":
        return {"status": "unsupported-wasm-version", "versionBytes": data[4:8].hex()}

    def u32(offset, limit):
        value = 0
        for index in range(5):
            if offset >= limit:
                raise ValueError("Truncated unsigned LEB128")
            byte = data[offset]
            offset += 1
            if index == 4 and byte & 0xF0:
                raise ValueError("Unsigned LEB128 exceeds 32 bits")
            value |= (byte & 127) << (7 * index)
            if byte < 128:
                return value, offset
        raise ValueError("Oversized unsigned LEB128")

    non_debug, debug = [], []
    digest = hashlib.sha256(data[:8])
    # Tag and data-count sections have proposal-defined positions before globals/CODE.
    order = {
        kind: rank
        for rank, kind in enumerate((1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11))
    }
    seen = set()
    previous_rank = -1
    offset = 8
    try:
        while offset < len(data):
            start = offset
            kind = data[offset]
            offset += 1
            size, offset = u32(offset, len(data))
            end = offset + size
            if end > len(data):
                raise ValueError("Truncated WASM section payload")
            name = None
            if kind == 0:
                name_size, name_start = u32(offset, end)
                if name_start + name_size > end:
                    raise ValueError("Custom section name exceeds its payload")
                name = data[name_start : name_start + name_size].decode("utf-8")
            else:
                if kind not in order:
                    raise ValueError("Unknown non-custom WASM section ID")
                if kind in seen or order[kind] <= previous_rank:
                    raise ValueError(
                        "Duplicate or out-of-order non-custom WASM section"
                    )
                seen.add(kind)
                previous_rank = order[kind]
            raw = data[start:end]
            record = {
                "id": kind,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "sizeBytes": len(raw),
            }
            if name is not None:
                record["customName"] = name
            if name is not None and name.startswith((".debug_", "reloc..debug_")):
                debug.append(record)
            else:
                non_debug.append(record)
                digest.update(raw)
            offset = end
    except ValueError as error:
        return {"status": "malformed-wasm-object", "error": str(error)}
    return {
        "status": "complete",
        "nonDebugSectionsSha256": digest.hexdigest(),
        "nonDebugSections": non_debug,
        "excludedDebugSections": debug,
    }


def fingerprint_archive_members(members):
    return [
        {
            "member": name,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "sizeBytes": len(payload),
            "objectSections": fingerprint_wasm_object(payload),
        }
        for name, payload in members.items()
    ]


def compare_object_sections(members, baseline):
    if baseline is None:
        return {
            "status": "baseline-not-provided",
            "allMemberNonDebugSectionsMatch": None,
        }
    expected = {row["member"]: row for row in baseline}
    if len(expected) != len(baseline):
        raise ValueError("Duplicate baseline object-section member")
    actual = {row["member"]: row for row in fingerprint_archive_members(members)}
    rows = []
    for name in sorted(set(actual) | set(expected)):
        first, second = expected.get(name), actual.get(name)
        before = (
            first["objectSections"] if first else {"status": "missing-baseline-member"}
        )
        after = (
            second["objectSections"] if second else {"status": "missing-built-member"}
        )
        complete = before["status"] == after["status"] == "complete"
        rows.append(
            {
                "member": name,
                "expected": first,
                "actual": second,
                "memberObjectBytesMatch": (
                    all(first[key] == second[key] for key in ("sha256", "sizeBytes"))
                    if first and second
                    else False
                ),
                "nonDebugSectionsMatch": (
                    before["nonDebugSections"] == after["nonDebugSections"]
                    and before["nonDebugSectionsSha256"]
                    == after["nonDebugSectionsSha256"]
                    if complete
                    else None
                ),
                "excludedDebugSectionsMatch": (
                    before["excludedDebugSections"] == after["excludedDebugSections"]
                    if complete
                    else None
                ),
            }
        )
    names_match = set(expected) == set(actual)
    return {
        "status": "complete",
        "scope": OBJECT_SECTION_SCOPE,
        "memberSetsMatch": names_match,
        "memberOrderMatches": list(expected) == list(actual),
        "expectedMemberCount": len(expected),
        "builtMemberCount": len(actual),
        "comparableMemberCount": sum(
            row["nonDebugSectionsMatch"] is not None for row in rows
        ),
        "matchingNonDebugMemberCount": sum(
            row["nonDebugSectionsMatch"] is True for row in rows
        ),
        "unavailableMemberCount": sum(
            row["nonDebugSectionsMatch"] is None for row in rows
        ),
        "allMemberNonDebugSectionsMatch": bool(rows)
        and names_match
        and all(row["nonDebugSectionsMatch"] is True for row in rows),
        "members": rows,
    }


def compare_archive(path, expected):
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise RuntimeError("Built archive exceeds the diagnostic size budget")
    actual = file_pin(path)
    members = parse_ar(path.read_bytes())
    comparisons = []
    for selected in expected["selectedMembers"]:
        payload = members.get(selected["member"])
        pin = (
            None
            if payload is None
            else {
                "sha256": hashlib.sha256(payload).hexdigest(),
                "sizeBytes": len(payload),
            }
        )
        wanted = {key: selected[key] for key in ("sha256", "sizeBytes")}
        comparisons.append(
            {
                "id": selected["id"],
                "member": selected["member"],
                "recipeSource": selected["recipeSource"],
                "actual": pin,
                "expected": wanted,
                "match": pin == wanted,
            }
        )
    return {
        "file": expected["file"],
        "target": expected["target"],
        "actual": actual,
        "expected": {key: expected[key] for key in ("sha256", "sizeBytes")},
        "wholeArchiveMatch": actual
        == {key: expected[key] for key in ("sha256", "sizeBytes")},
        "selectedMembers": comparisons,
        "objectSectionDiagnostics": compare_object_sections(
            members, expected.get("memberObjectSections")
        ),
    }


def download_source(pin, destination, opener=urllib.request.urlopen):
    digest = hashlib.sha256()
    received = 0
    with opener(pin["url"], timeout=120) as source, destination.open("xb") as target:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            received += len(chunk)
            if received > pin["sizeBytes"]:
                raise RuntimeError("Primary source download exceeds its pinned size")
            digest.update(chunk)
            target.write(chunk)
    actual = {"sha256": digest.hexdigest(), "sizeBytes": received}
    if actual != {key: pin[key] for key in ("sha256", "sizeBytes")}:
        raise RuntimeError("Primary source download differs from its pin")
    return {"url": pin["url"], **actual}


def inspect_tool(name, path, environment, runner):
    invoked = path.absolute()
    resolved = invoked.resolve(strict=True)
    record = {
        "name": name,
        "path": str(invoked),
        "resolvedPath": str(resolved),
        **file_pin(resolved),
    }
    runner([str(invoked), "--version"], environment)
    return record


def isolated_environment(sdk, source, output, capture, historical_header_prefix=None):
    if historical_header_prefix is None:
        historical_header_prefix = json.loads(DEFAULT_PLAN.read_text())[
            "historicalClangHeaderPrefix"
        ]
    header_prefix = str(sdk / "upstream/lib/clang/18/include")
    runpy.run_path(str(SDK_CAPTURE_ADAPTER))["header_prefix_flag"](
        header_prefix, historical_header_prefix
    )
    cache = source / "cache"
    configuration = output / "emscripten-config.py"
    values = {
        "LLVM_ROOT": str(sdk / "upstream/bin"),
        "BINARYEN_ROOT": str(sdk / "upstream"),
        "NODE_JS": [str(sdk / "node/16.20.0_64bit/bin/node")],
        "CACHE": str(cache),
        "FROZEN_CACHE": False,
    }
    configuration.write_text(
        "".join(f"{key} = {value!r}\n" for key, value in values.items())
    )
    temporary = output / "compiler-temporary"
    temporary.mkdir()
    environment = dict(os.environ)
    for key in (
        "EM_LLVM_ROOT",
        "EM_BINARYEN_ROOT",
        "EM_NODE_JS",
        "EM_FROZEN_CACHE",
        "EMCC_CFLAGS",
        "EMMAKEN_CFLAGS",
        "_EMCC_CCACHE",
    ):
        environment.pop(key, None)
    environment.update(
        EM_CONFIG=str(configuration),
        EM_CACHE=str(cache),
        EM_COMPILER_WRAPPER=str(SDK_CAPTURE_ADAPTER),
        ECS_COMPILE_CAPTURE=str(capture),
        ECS_SDK_CLANG_HEADER_FROM=header_prefix,
        ECS_SDK_CLANG_HEADER_TO=historical_header_prefix,
        EMCC_TEMP_DIR=str(temporary),
        EMCC_USE_NINJA="0",
        EMCC_CORES="2",
        BINARYEN_CORES="2",
        EMCC_DEBUG="1",
        PYTHONDONTWRITEBYTECODE="1",
        LC_ALL="C.UTF-8",
        PATH=str(source) + os.pathsep + environment["PATH"],
    )
    return environment, configuration


def run_builder(source, targets, case_sensitive, evidence):
    """Select the pinned builder's recorded filesystem branch before normal dispatch."""
    sys.path.insert(0, str(source))
    builder = importlib.import_module("embuilder")
    system_libs = builder.system_libs
    probe = source / "cache/build/case-probe"
    probe.mkdir(parents=True)
    native_sensitive = not system_libs.is_case_insensitive(str(probe))
    adapted = False
    if case_sensitive != native_sensitive:
        if platform.system() != "Linux" or case_sensitive:
            raise RuntimeError(
                "Requested baseline filesystem case mode is unsupported on this host"
            )
        system_libs.is_case_insensitive = lambda _: True
        adapted = True
    sys.argv = [str(source / "embuilder.py"), "build", *targets, "--verbose"]
    evidence.write_text(
        json.dumps(
            {
                "entrypoint": {
                    "file": str(source / "embuilder.py"),
                    **file_pin(source / "embuilder.py"),
                },
                "systemLibrariesRecipe": {
                    "file": str(Path(system_libs.__file__)),
                    **file_pin(Path(system_libs.__file__)),
                },
                "nativeCaseSensitive": native_sensitive,
                "requestedCaseSensitive": case_sensitive,
                "linuxCaseAdapterApplied": adapted,
                "args": sys.argv,
                "adapterScript": file_pin(Path(__file__)),
            },
            indent=2,
        )
        + "\n"
    )
    return builder.main()


def reconstruct(sdk, output, plan_path):
    output.mkdir()
    evidence = output / "evidence"
    evidence.mkdir()
    capture = evidence / "capture"
    capture.mkdir()
    report = {
        "schemaVersion": 1,
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": "build-failed",
        "scope": (
            "System archives rebuilt from primary Emscripten source "
            "using recorded prebuilt native tools."
        ),
        "commands": [],
        "tools": [],
        "sourceFiles": [],
        "archives": [],
    }

    def run(arguments, environment):
        log = evidence / f"command-{len(report['commands']) + 1:02d}.log"
        with log.open("w") as target:
            result = subprocess.run(
                arguments,
                cwd=output,
                env=environment,
                stdout=target,
                stderr=subprocess.STDOUT,
            )
        report["commands"].append(
            {
                "cwd": str(output),
                "args": arguments,
                "exitCode": result.returncode,
                "log": {"file": log.name, **file_pin(log)},
            }
        )
        if result.returncode:
            raise RuntimeError(f"Command failed. See {log.name}")
        return log.read_text()

    try:
        plan = json.loads(plan_path.read_text())
        archives = plan["archives"]
        if not archives or len({archive["file"] for archive in archives}) != len(
            archives
        ):
            raise RuntimeError("Unique planned archive outputs are required")
        for archive_pin in archives:
            if Path(archive_pin["file"]).name != archive_pin["file"] or not archive_pin[
                "file"
            ].endswith(".a"):
                raise RuntimeError("A planned SDK archive filename is invalid")
            if not re.fullmatch(r"[A-Za-z0-9_+.-]+", archive_pin["target"]):
                raise RuntimeError("A planned SDK library target is invalid")
            selected = archive_pin["selectedMembers"]
            if len({member["member"] for member in selected}) != len(selected):
                raise RuntimeError("Unique selected archive members are required")
            baseline = archive_pin.get("memberObjectSections")
            if not baseline or len({row["member"] for row in baseline}) != len(
                baseline
            ):
                raise RuntimeError("All-member SDK object-section baseline is required")
            baseline_by_name = {row["member"]: row for row in baseline}
            for member in selected:
                pinned = baseline_by_name.get(member["member"])
                if pinned is None or any(
                    pinned[key] != member[key] for key in ("sha256", "sizeBytes")
                ):
                    raise RuntimeError(
                        "Selected member differs from object-section baseline"
                    )
        if plan["schemaVersion"] != 1 or plan["sdkVersion"] != "3.1.46":
            raise RuntimeError("The pinned SDK 3.1.46 reconstruction plan is required")
        if not isinstance(plan["hostFileSystem"]["caseSensitive"], bool):
            raise RuntimeError("The baseline filesystem case mode is required")
        if (
            plan["source"]["url"]
            != "https://codeload.github.com/emscripten-core/emscripten/tar.gz/"
            + plan["compilerRevision"]
        ):
            raise RuntimeError("Primary source URL differs from the compiler revision")
        runpy.run_path(str(SDK_CAPTURE_ADAPTER))["header_prefix_flag"](
            str(sdk / "upstream/lib/clang/18/include"),
            plan["historicalClangHeaderPrefix"],
        )
        report["plan"] = {"file": str(plan_path), **file_pin(plan_path)}
        report["diagnosticScript"] = file_pin(Path(__file__))
        report["baselineHostFileSystem"] = plan["hostFileSystem"]
        report["archiveScope"] = plan["archiveScope"]
        if (
            run(["git", "-C", str(sdk), "rev-parse", "HEAD"], os.environ).strip()
            != plan["emsdkRevision"]
        ):
            raise RuntimeError("Pinned emsdk checkout required")
        report["emsdkRevision"] = plan["emsdkRevision"]
        archive = output / "primary-source.tar.gz"
        report["sourceArchive"] = download_source(plan["source"], archive)
        source = output / "source"
        source.mkdir()
        with tarfile.open(archive) as tar:
            for member in tar:
                root, separator, name = member.name.partition("/")
                if root != "emscripten-" + plan["compilerRevision"]:
                    raise RuntimeError("Unexpected primary source archive root")
                if separator and name:
                    member.name = name
                    tar.extract(member, source, filter="data")
        cache = source / "cache"
        if cache.exists():
            raise RuntimeError(
                "The primary source archive contains a preexisting cache"
            )
        report["initialCacheEntries"] = []
        environment, configuration = isolated_environment(
            sdk, source, output, capture, plan["historicalClangHeaderPrefix"]
        )
        report["clangHeaderDebugPrefixMapping"] = {
            "from": environment["ECS_SDK_CLANG_HEADER_FROM"],
            "to": environment["ECS_SDK_CLANG_HEADER_TO"],
            "effectiveAddedArgument": runpy.run_path(str(SDK_CAPTURE_ADAPTER))[
                "header_prefix_flag"
            ](
                environment["ECS_SDK_CLANG_HEADER_FROM"],
                environment["ECS_SDK_CLANG_HEADER_TO"],
            ),
            "adapter": {
                "file": str(SDK_CAPTURE_ADAPTER.relative_to(REPOSITORY)),
                **file_pin(SDK_CAPTURE_ADAPTER),
            },
            "captureHelper": {
                "file": str(CAPTURE_WRAPPER.relative_to(REPOSITORY)),
                **file_pin(CAPTURE_WRAPPER),
            },
            "baselineObservation": plan.get("historicalClangHeaderPrefixEvidence"),
            "scope": (
                "Injects only a compiler debug-prefix mapping before the original "
                "arguments. No macro/runtime prefix map, source patch or "
                "binary rewriting."
            ),
        }
        report["configuration"] = {
            "file": configuration.name,
            **file_pin(configuration),
        }
        report["environment"] = {
            key: environment[key]
            for key in (
                "EM_CONFIG",
                "EM_CACHE",
                "EM_COMPILER_WRAPPER",
                "ECS_COMPILE_CAPTURE",
                "ECS_SDK_CLANG_HEADER_FROM",
                "ECS_SDK_CLANG_HEADER_TO",
                "EMCC_TEMP_DIR",
                "EMCC_USE_NINJA",
                "EMCC_CORES",
                "BINARYEN_CORES",
                "EMCC_DEBUG",
                "PYTHONDONTWRITEBYTECODE",
                "LC_ALL",
            )
        }
        for name, path in {
            "python": Path(sys.executable),
            "clang": sdk / "upstream/bin/clang",
            "clang++": sdk / "upstream/bin/clang++",
            "llvm-ar": sdk / "upstream/bin/llvm-ar",
            "llvm-nm": sdk / "upstream/bin/llvm-nm",
            "wasm-ld": sdk / "upstream/bin/wasm-ld",
            "wasm-opt": sdk / "upstream/bin/wasm-opt",
            "node": sdk / "node/16.20.0_64bit/bin/node",
        }.items():
            report["tools"].append(inspect_tool(name, path, environment, run))
        for name in (
            "embuilder.py",
            "emcc.py",
            "emar.py",
            "tools/system_libs.py",
            "tools/cache.py",
            "tools/config.py",
            "tools/shared.py",
        ):
            report["sourceFiles"].append({"file": name, **file_pin(source / name)})
        if (
            file_pin(source / "tools/system_libs.py")["sha256"]
            != plan["hostFileSystem"]["recipeSha256"]
        ):
            raise RuntimeError("The filesystem case recipe differs from its source pin")
        version = run(
            [sys.executable, str(source / "emcc.py"), "--version"], environment
        )
        if not re.search(r"\b3\.1\.46\b", version):
            raise RuntimeError("Pinned Emscripten source version required")
        report["compilerVersion"] = version.strip()
        targets = [archive["target"] for archive in plan["archives"]]
        case_mode = (
            "sensitive" if plan["hostFileSystem"]["caseSensitive"] else "insensitive"
        )
        run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--run-builder",
                "--builder-source",
                str(source),
                "--case-mode",
                case_mode,
                "--adapter-evidence",
                str(evidence / "builder-adapter.json"),
                *targets,
            ],
            environment,
        )
        for expected in plan["archives"]:
            report["archives"].append(
                compare_archive(
                    cache / "sysroot/lib/wasm32-emscripten" / expected["file"], expected
                )
            )
        members = [
            member
            for archive in report["archives"]
            for member in archive["selectedMembers"]
        ]
        report["comparison"] = {
            "wholeArchives": len(report["archives"]),
            "exactWholeArchives": sum(
                archive["wholeArchiveMatch"] for archive in report["archives"]
            ),
            "selectedMembers": len(members),
            "exactSelectedMembers": sum(member["match"] for member in members),
        }
        section_diagnostics = [
            archive["objectSectionDiagnostics"] for archive in report["archives"]
        ]
        report["objectSectionComparison"] = {
            "scope": OBJECT_SECTION_SCOPE,
            "archiveCount": len(section_diagnostics),
            "matchingNonDebugArchives": sum(
                item["allMemberNonDebugSectionsMatch"] is True
                for item in section_diagnostics
            ),
            "comparableMembers": sum(
                item["comparableMemberCount"] for item in section_diagnostics
            ),
            "matchingNonDebugMembers": sum(
                item["matchingNonDebugMemberCount"] for item in section_diagnostics
            ),
            "unavailableMembers": sum(
                item["unavailableMemberCount"] for item in section_diagnostics
            ),
        }
        exact = all(
            archive["wholeArchiveMatch"] for archive in report["archives"]
        ) and all(member["match"] for member in members)
        report["status"] = (
            "exact-sdk-archives-reproduced" if exact else "built-archives-mismatch"
        )
    except Exception as error:
        report["error"] = str(error)
    finally:
        adapter = evidence / "builder-adapter.json"
        if adapter.is_file():
            report["builderAdapter"] = {
                "file": adapter.name,
                **file_pin(adapter),
            }
        try:
            report["compilerInputCapture"] = capture_summary(capture, CAPTURE_WRAPPER)
        except Exception as error:
            report["status"] = "build-failed"
            report["captureError"] = str(error)
        (evidence / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "status": report["status"],
                "comparison": report.get("comparison"),
                "objectSectionComparison": report.get("objectSectionComparison"),
                "error": report.get("error"),
            },
            indent=2,
        )
    )
    return report["status"] == "exact-sdk-archives-reproduced"


def self_test(sdk=None):
    import tempfile
    import unittest

    def member(name, payload):
        fields = (
            name.ljust(16),
            "0".ljust(12),
            "0".ljust(6),
            "0".ljust(6),
            "100644".ljust(8),
            str(len(payload)).ljust(10),
        )
        return (
            "".join(fields).encode()
            + b"`\n"
            + payload
            + (b"\n" if len(payload) % 2 else b"")
        )

    def u32(value):
        encoded = bytearray()
        while value >= 128:
            encoded.append((value & 127) | 128)
            value >>= 7
        return bytes(encoded) + bytes([value])

    def wasm_object(parts):
        return b"\0asm\x01\0\0\0" + b"".join(
            bytes([kind]) + u32(len(payload)) + payload for kind, payload in parts
        )

    def custom(name, payload):
        encoded = name.encode()
        return 0, u32(len(encoded)) + encoded + payload

    class ArchiveTests(unittest.TestCase):
        def test_header_prefix_adapter_preserves_driver_and_forwards_only_debug_flag(
            self,
        ):
            adapter = runpy.run_path(str(SDK_CAPTURE_ADAPTER))
            arguments = [
                "/tools/clang++",
                "-c",
                "a file.cpp",
                "-o",
                "a file.o",
                "-DVALUE=1",
            ]
            original = list(arguments)
            forwarded = []
            status = adapter["capture_sdk_compiler"](
                arguments,
                "/sdk with spaces/upstream/lib/clang/18/include",
                "/opt/s/w/ir/x/w/install/lib/clang/18/include",
                lambda command: forwarded.append(command) or 7,
            )
            self.assertEqual(status, 7)
            self.assertEqual(arguments, original)
            self.assertEqual(
                forwarded,
                [
                    [
                        original[0],
                        "-fdebug-prefix-map=/sdk with spaces"
                        "/upstream/lib/clang/18/include="
                        "/opt/s/w/ir/x/w/install/lib/clang/18/include",
                        *original[1:],
                    ]
                ],
            )
            for prefix in ["", "relative/include", "/bad=prefix", "/bad\npath"]:
                with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                    adapter["capture_sdk_compiler"](
                        arguments, prefix, "/historical", lambda _: 0
                    )

        def test_isolated_capture_uses_explicit_observed_header_prefix_mapping(self):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "source"
                source.mkdir()
                environment, _ = isolated_environment(
                    root / "sdk",
                    source,
                    root,
                    root / "capture",
                    "/opt/s/w/ir/x/w/install/lib/clang/18/include",
                )
                self.assertEqual(
                    environment["EM_COMPILER_WRAPPER"], str(SDK_CAPTURE_ADAPTER)
                )
                self.assertEqual(
                    environment["ECS_SDK_CLANG_HEADER_FROM"],
                    str(root / "sdk/upstream/lib/clang/18/include"),
                )
                self.assertEqual(
                    environment["ECS_SDK_CLANG_HEADER_TO"],
                    "/opt/s/w/ir/x/w/install/lib/clang/18/include",
                )
                self.assertEqual(
                    environment["ECS_COMPILE_CAPTURE"], str(root / "capture")
                )

        def test_object_sections_exclude_only_explicit_debug_custom_sections(self):
            retained = [
                (10, b"code"),
                (11, b"data"),
                custom("linking", b"symbols"),
                custom("reloc.CODE", b"code relocations"),
                custom("reloc.DATA", b"data relocations"),
                custom("producers", b"compiler"),
                custom("target_features", b"features"),
                custom("other", b"metadata"),
            ]
            first = fingerprint_wasm_object(
                wasm_object(
                    retained
                    + [
                        custom(".debug_info", b"old debug"),
                        custom("reloc..debug_info", b"old debug relocations"),
                    ]
                )
            )
            second = fingerprint_wasm_object(
                wasm_object(
                    retained
                    + [
                        custom(".debug_info", b"different longer debug"),
                        custom("reloc..debug_info", b"different relocations"),
                    ]
                )
            )
            self.assertEqual(first["status"], "complete")
            self.assertEqual(
                first["nonDebugSectionsSha256"], second["nonDebugSectionsSha256"]
            )
            self.assertNotEqual(
                first["excludedDebugSections"], second["excludedDebugSections"]
            )
            for index in range(len(retained)):
                changed = list(retained)
                kind, payload = changed[index]
                changed[index] = kind, payload + b"changed"
                with self.subTest(section=index):
                    different = fingerprint_wasm_object(wasm_object(changed))
                    self.assertNotEqual(
                        first["nonDebugSectionsSha256"],
                        different["nonDebugSectionsSha256"],
                    )
            for name in ("debug_info", ".debug", ".debugger", "reloc.debug_info"):
                named_debug = fingerprint_wasm_object(wasm_object([custom(name, b"x")]))
                self.assertEqual(len(named_debug["nonDebugSections"]), 1)
            padded = fingerprint_wasm_object(b"\0asm\x01\0\0\0\x01\x80\x00")
            unpadded = fingerprint_wasm_object(wasm_object([(1, b"")]))
            self.assertNotEqual(
                padded["nonDebugSectionsSha256"], unpadded["nonDebugSectionsSha256"]
            )

        def test_malformed_or_unsupported_objects_never_produce_section_equality(self):
            header = b"\0asm\x01\0\0\0"
            malformed = [
                header[:-1],
                header + b"\x01\x80",
                header + b"\x01\x80\x80\x80\x80\x10",
                header + b"\x01\x04x",
                header + b"\x00\x02\x05x",
                header + b"\x00\x02\x01\xff",
                wasm_object([(1, b""), (1, b"")]),
                wasm_object([(10, b""), (1, b"")]),
            ]
            for payload in malformed:
                with self.subTest(payload=payload):
                    result = fingerprint_wasm_object(payload)
                    self.assertEqual(result["status"], "malformed-wasm-object")
                    self.assertNotIn("nonDebugSectionsSha256", result)
            for payload in [b"LLVM bitcode", b"\0asm\x02\0\0\0"]:
                with self.subTest(payload=payload):
                    result = fingerprint_wasm_object(payload)
                    self.assertTrue(result["status"].startswith("unsupported-"))
                    self.assertNotIn("nonDebugSectionsSha256", result)

        def test_archive_byte_pins_and_non_debug_section_diagnostics_stay_separate(
            self,
        ):
            original = wasm_object(
                [
                    (10, b"code"),
                    custom("linking", b"symbols"),
                    custom(".debug_info", b"first"),
                ]
            )
            changed_debug = wasm_object(
                [
                    (10, b"code"),
                    custom("linking", b"symbols"),
                    custom(".debug_info", b"other"),
                ]
            )
            changed_linking = wasm_object(
                [
                    (10, b"code"),
                    custom("linking", b"different"),
                    custom(".debug_info", b"first"),
                ]
            )
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "fixture.a"
                archived = b"!<arch>\n" + member("x.o/", original)
                expected = {
                    "file": path.name,
                    "target": "fixture",
                    "sha256": hashlib.sha256(archived).hexdigest(),
                    "sizeBytes": len(archived),
                    "selectedMembers": [],
                    "memberObjectSections": fingerprint_archive_members(
                        {"x.o": original}
                    ),
                }
                path.write_bytes(b"!<arch>\n" + member("x.o/", changed_debug))
                comparison = compare_archive(path, expected)
                self.assertFalse(comparison["wholeArchiveMatch"])
                self.assertTrue(
                    comparison["objectSectionDiagnostics"][
                        "allMemberNonDebugSectionsMatch"
                    ]
                )
                path.write_bytes(b"!<arch>\n" + member("x.o/", changed_linking))
                self.assertFalse(
                    compare_archive(path, expected)["objectSectionDiagnostics"][
                        "allMemberNonDebugSectionsMatch"
                    ]
                )
                path.write_bytes(b"!<arch>\n" + member("x.o/", b"unsupported bitcode"))
                expected["memberObjectSections"] = fingerprint_archive_members(
                    {"x.o": b"unsupported bitcode"}
                )
                unavailable = compare_archive(path, expected)[
                    "objectSectionDiagnostics"
                ]
                self.assertFalse(unavailable["allMemberNonDebugSectionsMatch"])
                self.assertIsNone(unavailable["members"][0]["nonDebugSectionsMatch"])
                path.write_bytes(b"!<arch>\n" + member("other.o/", original))
                missing = compare_archive(path, expected)["objectSectionDiagnostics"]
                self.assertFalse(missing["memberSetsMatch"])
                self.assertFalse(missing["allMemberNonDebugSectionsMatch"])

        def test_regular_gnu_long_names_and_symbol_indexes(self):
            data = (
                b"!<arch>\n"
                + member("/", b"index")
                + member("/SYM64/", b"symbols")
                + member("//", b"a_very_long_member_name.o/\n")
                + member("/0", b"payload")
                + member("short.o/", b"abc")
            )
            self.assertEqual(
                parse_ar(data),
                {"a_very_long_member_name.o": b"payload", "short.o": b"abc"},
            )

        def test_tool_symlink_keeps_its_driver_name(self):
            with tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "lld"
                target.write_bytes(b"tool bytes")
                driver = Path(directory) / "wasm-ld"
                driver.symlink_to(target)
                calls = []
                record = inspect_tool(
                    "wasm-ld", driver, {}, lambda args, env: calls.append(args)
                )
                self.assertEqual(calls, [[str(driver), "--version"]])
                self.assertEqual(record["resolvedPath"], str(target.resolve()))
                self.assertEqual(record["sha256"], file_pin(target)["sha256"])

        def test_bsd_long_names(self):
            name = b"another_long_member_name.o"
            data = b"!<arch>\n" + member("#1/" + str(len(name)), name + b"data")
            self.assertEqual(parse_ar(data), {name.decode(): b"data"})

        def test_thin_truncated_duplicate_and_invalid_name_offsets_fail(self):
            for data in (
                b"!<thin>\n",
                b"!<arch>\n" + b"short",
                (b"!<arch>\n" + member("x.o/", b"abc"))[:-1],
                b"!<arch>\n" + member("x.o/", b"a") + member("x.o/", b"b"),
                b"!<arch>\n" + member("//", b"long_member.o/\n") + member("/1", b"a"),
            ):
                with self.subTest(data=data), self.assertRaises(ValueError):
                    parse_ar(data)

        def test_whole_archive_mismatch_is_separate_from_matching_selected_members(
            self,
        ):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "libfixture.a"
                original = b"!<arch>\n" + member("/", b"first") + member("x.o/", b"abc")
                expected = {
                    "file": path.name,
                    "target": "libfixture",
                    "sha256": hashlib.sha256(original).hexdigest(),
                    "sizeBytes": len(original),
                    "selectedMembers": [
                        {
                            "id": "libfixture.a(x.o)",
                            "member": "x.o",
                            "recipeSource": "fixture.c",
                            "sha256": hashlib.sha256(b"abc").hexdigest(),
                            "sizeBytes": 3,
                        }
                    ],
                }
                path.write_bytes(original)
                self.assertTrue(compare_archive(path, expected)["wholeArchiveMatch"])
                path.write_bytes(
                    b"!<arch>\n" + member("/", b"other") + member("x.o/", b"abc")
                )
                changed = compare_archive(path, expected)
                self.assertFalse(changed["wholeArchiveMatch"])
                self.assertTrue(changed["selectedMembers"][0]["match"])
                path.write_bytes(
                    b"!<arch>\n" + member("/", b"first") + member("x.o/", b"abd")
                )
                self.assertFalse(
                    compare_archive(path, expected)["selectedMembers"][0]["match"]
                )

        def test_primary_source_size_and_hash_are_both_required(self):
            payload = b"generated primary source"
            pin = {
                "url": "https://example.com/source",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "sizeBytes": len(payload),
            }
            for data, valid in (
                (payload, True),
                (b"x" * len(payload), False),
                (payload + b"x", False),
            ):
                with self.subTest(
                    valid=valid
                ), tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "source.tar.gz"
                    if valid:
                        self.assertEqual(
                            download_source(
                                pin, path, lambda *a, **k: io.BytesIO(data)
                            )["sha256"],
                            pin["sha256"],
                        )
                    else:
                        with self.assertRaises(RuntimeError):
                            download_source(pin, path, lambda *a, **k: io.BytesIO(data))

        def test_linux_adapter_selects_the_pinned_case_branch_without_changing_source(
            self,
        ):
            from types import SimpleNamespace
            from unittest.mock import patch

            with tempfile.TemporaryDirectory() as directory:
                source = Path(directory)
                (source / "embuilder.py").write_text("# generated entrypoint\n")
                recipe = source / "system_libs.py"
                recipe.write_text("# generated pinned recipe\n")
                library = SimpleNamespace(
                    __file__=str(recipe), is_case_insensitive=lambda _: False
                )
                observed = {}

                def main():
                    observed["insensitive"] = library.is_case_insensitive("build")
                    observed["args"] = list(sys.argv)
                    return 0

                builder = SimpleNamespace(system_libs=library, main=main)
                evidence = source / "adapter.json"
                with patch.dict(sys.modules, {"embuilder": builder}), patch(
                    "platform.system", return_value="Linux"
                ), patch.object(sys, "path", list(sys.path)), patch.object(
                    sys, "argv", list(sys.argv)
                ):
                    self.assertEqual(
                        run_builder(source, ["libfixture"], False, evidence), 0
                    )
                self.assertTrue(observed["insensitive"])
                self.assertEqual(
                    observed["args"],
                    [str(source / "embuilder.py"), "build", "libfixture", "--verbose"],
                )
                self.assertEqual(recipe.read_text(), "# generated pinned recipe\n")
                record = json.loads(evidence.read_text())
                self.assertTrue(record["linuxCaseAdapterApplied"])
                self.assertTrue(record["nativeCaseSensitive"])

        def test_failed_plan_validation_still_writes_a_receipt(self):
            from contextlib import redirect_stdout

            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                plan = root / "invalid-plan.json"
                plan.write_text(json.dumps({"archives": []}))
                output = root / "diagnostic"
                with redirect_stdout(io.StringIO()):
                    self.assertFalse(reconstruct(root / "unused-sdk", output, plan))
                receipt = json.loads((output / "evidence/receipt.json").read_text())
                self.assertEqual(receipt["status"], "build-failed")
                self.assertIn("planned archive outputs", receipt["error"])

        @unittest.skipUnless(
            sdk, "Provide --sdk for the tiny raw-assembly capture regression"
        )
        def test_raw_assembly_capture_preserves_object_bytes(self):
            with tempfile.TemporaryDirectory(prefix="ecs sdk assembly ") as directory:
                root = Path(directory).resolve()
                source = root / "source"
                source.mkdir()
                capture = root / "capture"
                capture.mkdir()
                environment, _ = isolated_environment(sdk, source, root, capture)
                emcc = sdk / "upstream/emscripten/emcc.py"
                c_source = root / "tiny.c"
                c_source.write_text("int value(void) { return 7; }\n")
                assembly = root / "tiny.s"
                baseline = dict(environment)
                baseline.pop("EM_COMPILER_WRAPPER")
                subprocess.run(
                    [
                        sys.executable,
                        str(emcc),
                        "-S",
                        str(c_source),
                        "-o",
                        str(assembly),
                    ],
                    env=baseline,
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                original = root / "original.o"
                rebuilt = root / "captured.o"
                subprocess.run(
                    [
                        sys.executable,
                        str(emcc),
                        "-c",
                        str(assembly),
                        "-o",
                        str(original),
                    ],
                    env=baseline,
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                result = subprocess.run(
                    [
                        sys.executable,
                        str(emcc),
                        "-c",
                        str(assembly),
                        "-o",
                        str(rebuilt),
                    ],
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(rebuilt.read_bytes(), original.read_bytes())
                commands = [
                    json.loads(path.read_text())
                    for path in (capture / "commands").glob("*.json")
                ]
                compiled = [command for command in commands if "-c" in command["args"]]
                self.assertEqual(len(compiled), 1)
                record = compiled[0]
                self.assertIn(
                    record["args"][0],
                    [
                        str(sdk / "upstream/bin/clang"),
                        str(sdk / "upstream/bin/clang++"),
                    ],
                )
                self.assertEqual(
                    record["args"][1],
                    f"-fdebug-prefix-map={environment['ECS_SDK_CLANG_HEADER_FROM']}={environment['ECS_SDK_CLANG_HEADER_TO']}",
                )
                self.assertEqual(
                    record["outputObject"]["sha256"], file_pin(original)["sha256"]
                )
                inputs = {item["path"]: item for item in record["inputFiles"]}
                self.assertEqual(
                    (
                        capture / inputs[str(assembly)]["retainedSnapshotPath"]
                    ).read_bytes(),
                    assembly.read_bytes(),
                )
                nested = root / "unrecorded.s"
                nested.write_bytes(assembly.read_bytes())
                assembly.write_text(f'.include "{nested}"\n')
                rejected = subprocess.run(
                    [
                        sys.executable,
                        str(emcc),
                        "-c",
                        str(assembly),
                        "-o",
                        str(root / "rejected.o"),
                    ],
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                self.assertNotEqual(rejected.returncode, 0)
                failures = [
                    json.loads(path.read_text())
                    for path in (capture / "commands").glob("*.json")
                ]
                self.assertTrue(
                    any(
                        "include directives" in command.get("captureError", "")
                        and command["exitCode"] is None
                        for command in failures
                    )
                )

    return (
        unittest.TextTestRunner()
        .run(unittest.defaultTestLoader.loadTestsFromTestCase(ArchiveTests))
        .wasSuccessful()
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--run-builder", action="store_true")
    parser.add_argument("--builder-source", type=Path)
    parser.add_argument("--adapter-evidence", type=Path)
    parser.add_argument("--case-mode", choices=("sensitive", "insensitive"))
    parser.add_argument("targets", nargs="*")
    arguments = parser.parse_args()
    if arguments.self_test:
        sys.exit(
            0 if self_test(arguments.sdk.resolve() if arguments.sdk else None) else 1
        )
    if arguments.run_builder:
        if (
            not arguments.builder_source
            or not arguments.adapter_evidence
            or not arguments.case_mode
        ):
            parser.error("Builder source, case mode and adapter evidence are required")
        sys.exit(
            run_builder(
                arguments.builder_source.resolve(),
                arguments.targets,
                arguments.case_mode == "sensitive",
                arguments.adapter_evidence.resolve(),
            )
        )
    if not arguments.sdk or not arguments.output:
        parser.error("--sdk and --output are required")
    sys.exit(
        0
        if reconstruct(
            arguments.sdk.resolve(),
            arguments.output.resolve(),
            arguments.plan.resolve(),
        )
        else 1
    )
