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


def isolated_environment(sdk, source, output, capture):
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
        EM_COMPILER_WRAPPER=str(CAPTURE_WRAPPER),
        ECS_COMPILE_CAPTURE=str(capture),
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
        environment, configuration = isolated_environment(sdk, source, output, capture)
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

    class ArchiveTests(unittest.TestCase):
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
                self.assertEqual(record["resolvedPath"], str(target))
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
