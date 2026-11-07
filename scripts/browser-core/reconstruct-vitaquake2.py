#!/usr/bin/env python3
"""Fresh Linux reconstruction of a selected dated runtime pair, retaining evidence."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request


REPOSITORY = Path(__file__).resolve().parents[2]
SDK_REVISION = "93360d3670018769b424e4e8f1d3d9b26d32c977"
COMPILER_IDENTITY = "3.1.46 (19607820c447a13fd8d0b7680c56148427d6e1b8)"
# Source tarball pins measured for the commits in the dated mapping/resolution reports.
SOURCE_ARCHIVES = {
    "core": {
        "revision": "4b333fe18e8816974f04432af01f87654ae16e21",
        "repository": "libretro/vitaquake2",
        "sha256": "c91570472a0f9265d9166496bd80b7950e52555d8ea521ae0a62feade4468429",
        "sizeBytes": 2677193,
    },
    "frontend": {
        "revision": "6ebf66b6433235d582e627fc802ff4b966613720",
        "repository": "libretro/RetroArch",
        "sha256": "b8a1a7ed3019bcd6621bffc4cb69039649c48c7c54b73621e16803bf9033f9e5",
        "sizeBytes": 82616406,
    },
}


CORE_RECIPES = {
    "vitaquake2": {
        "source": SOURCE_ARCHIVES["core"],
        "directory": ".",
        "memoryBytes": 402653184,
        "makeArguments": [f'GIT_VERSION=" {SOURCE_ARCHIVES["core"]["revision"][:7]}"'],
    },
    "fbneo": {
        "source": {
            "revision": "9d82650bb9591966987a4c36ae8a1409ce0d5d68",
            "repository": "libretro/fbneo",
            "sha256": (
                "671498c5a0cbcfac28a69427800a7f679" "ad68002da705bbf5e8d5a5ab7ef33ba"
            ),
            "sizeBytes": 27498805,
        },
        "directory": "src/burner/libretro",
        "memoryBytes": 134217728,
        # Makefile.common adds "GIT" and derives YYMMDD from git history.
        # The pinned commit is dated 2026-10-29. Tarballs omit that history.
        # https://github.com/libretro/FBNeo/blob/9d82650bb9591966987a4c36ae8a1409ce0d5d68/src/burner/libretro/Makefile.common#L389-L392
        "makeArguments": ["GIT_VERSION=9d82650", "GIT_DATE=261029"],
    },
}


def file_pin(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "sizeBytes": path.stat().st_size}


def compare_resource(built, original, expected):
    output_pin = file_pin(built)
    original_pin = file_pin(original)
    pinned = {key: expected[key] for key in ("sha256", "sizeBytes")}
    return {
        "file": expected["file"],
        **output_pin,
        "expectedSha256": pinned["sha256"],
        "expectedSizeBytes": pinned["sizeBytes"],
        "originalMatchesCatalogPin": original_pin == pinned,
        "hashAndSizeMatch": output_pin == pinned,
        "directByteEquality": built.read_bytes() == original.read_bytes(),
    }


def capture_summary(capture, wrapper):
    commands = [
        {"file": str(path.relative_to(capture)), **file_pin(path)}
        for path in sorted((capture / "commands").glob("*.json"))
    ]
    inputs = []
    for path in sorted((capture / "inputs").glob("*")):
        pin = file_pin(path)
        if path.name != pin["sha256"]:
            raise RuntimeError("Compiler input snapshot differs from its content hash")
        inputs.append({"file": str(path.relative_to(capture)), **pin})
    manifest = capture / "manifest.json"
    manifest.write_text(
        json.dumps(
            {"schemaVersion": 1, "commands": commands, "inputs": inputs}, indent=2
        )
        + "\n"
    )
    return {
        "path": "capture",
        "wrapper": {"file": str(wrapper.relative_to(REPOSITORY)), **file_pin(wrapper)},
        "manifest": {"file": "capture/manifest.json", **file_pin(manifest)},
        "commandRecords": len(commands),
        "uniqueInputSnapshots": len(inputs),
        "snapshotBytes": sum(item["sizeBytes"] for item in inputs),
    }


def self_test(sdk=None):
    from contextlib import redirect_stdout
    import io
    import tempfile
    import unittest
    from unittest.mock import patch

    class ComparisonTests(unittest.TestCase):
        def test_actual_bytes_and_catalog_pins_must_both_match(self):
            with tempfile.TemporaryDirectory() as directory:
                original = Path(directory) / "original"
                built = Path(directory) / "built"
                original.write_bytes(b"generated fixture")
                built.write_bytes(original.read_bytes())
                expected = {"file": "fixture.wasm", **file_pin(original)}
                same = compare_resource(built, original, expected)
                self.assertTrue(same["directByteEquality"])
                self.assertTrue(same["hashAndSizeMatch"])
                built.write_bytes(b"generated fixturE")
                changed = compare_resource(built, original, expected)
                self.assertFalse(changed["directByteEquality"])
                self.assertFalse(changed["hashAndSizeMatch"])
                original.write_bytes(built.read_bytes())
                changed_original = compare_resource(built, original, expected)
                self.assertTrue(changed_original["directByteEquality"])
                self.assertFalse(changed_original["originalMatchesCatalogPin"])

        @unittest.skipUnless(sdk, "Provide --sdk to exercise activated SDK startup")
        def test_fresh_workspace_runs_sdk_before_downloading(self):
            for core in ("vitaquake2", "fbneo"):
                with self.subTest(
                    core=core
                ), tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / "diagnostic"
                    stop = "Preflight stops before downloading"
                    with patch(
                        "urllib.request.urlopen", side_effect=RuntimeError(stop)
                    ) as network:
                        with redirect_stdout(io.StringIO()):
                            self.assertFalse(reconstruct(sdk, output, core))
                    report = json.loads((output / "evidence/receipt.json").read_text())
                    self.assertEqual(report["id"], "org.libretro." + core)
                    self.assertEqual(report["error"], stop)
                    self.assertEqual(network.call_count, 1)
                    self.assertIn(COMPILER_IDENTITY, report["compilerVersion"])
                    self.assertTrue((output / "compiler-temporary").is_dir())
                    self.assertTrue(report["commands"])
                    self.assertTrue(all(c["exitCode"] == 0 for c in report["commands"]))

        @unittest.skipUnless(sdk, "Provide --sdk to exercise compiler input capture")
        def test_capture_retains_used_source_and_header_bytes(self):
            with tempfile.TemporaryDirectory(prefix="ecs capture ") as directory:
                root = Path(directory).resolve()
                source = root / "fixture.c"
                header = root / "x.h"
                source.write_text('#include "x.h"\nint x= VALUE;\n//\n')
                header.write_text("#include <stdint.h>\n#define VALUE 7\n")
                capture = root / "capture"
                environment = dict(os.environ)
                environment.update(
                    EM_COMPILER_WRAPPER=str(
                        REPOSITORY / "scripts/browser-core/capture-upstream-compiler.py"
                    ),
                    ECS_COMPILE_CAPTURE=str(capture),
                )
                self.assertEqual(source.stat().st_size, 32)
                products = [root / "fixture-1.o", root / "fixture-2.o"]
                processes = [
                    subprocess.Popen(
                        ["emcc", "-c", str(source), "-o", str(product)],
                        env=environment,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                    for product in products
                ]
                for process in processes:
                    _, errors = process.communicate()
                    self.assertEqual(process.returncode, 0, errors.decode())
                commands = [
                    json.loads(path.read_text())
                    for path in (capture / "commands").glob("*.json")
                ]
                compiled = [command for command in commands if "-c" in command["args"]]
                self.assertEqual(len(compiled), 2)
                for command in compiled:
                    product = Path(command["outputObject"]["path"])
                    self.assertIn(product, products)
                    self.assertEqual(
                        {
                            key: command["outputObject"][key]
                            for key in ("sha256", "sizeBytes")
                        },
                        file_pin(product),
                    )
                inputs = compiled[0]["inputFiles"]
                by_path = {item["path"]: item for item in inputs}
                for path in (source, header):
                    item = by_path[str(path.resolve())]
                    self.assertEqual(
                        {key: item[key] for key in ("sha256", "sizeBytes")},
                        file_pin(path),
                    )
                    self.assertEqual(
                        (capture / item["retainedSnapshotPath"]).read_bytes(),
                        path.read_bytes(),
                    )
                self.assertTrue(
                    any(
                        item["path"].startswith(str(sdk / "upstream"))
                        for item in inputs
                    )
                )
                snapshots = list((capture / "inputs").iterdir())
                self.assertEqual(
                    {path.name for path in snapshots},
                    {item["sha256"] for item in inputs},
                )
                for product in products:
                    self.assertNotIn(
                        file_pin(product)["sha256"], {path.name for path in snapshots}
                    )

    return (
        unittest.TextTestRunner()
        .run(unittest.defaultTestLoader.loadTestsFromTestCase(ComparisonTests))
        .wasSuccessful()
    )


def reconstruct(sdk, output, core_name="vitaquake2"):
    recipe = CORE_RECIPES[core_name]
    sources = {**SOURCE_ARCHIVES, "core": recipe["source"]}
    output.mkdir()  # Exclusive workspace preserves any previous diagnostic attempt.
    evidence = output / "evidence"
    evidence.mkdir()
    (output / "compiler-temporary").mkdir()
    report = {
        "schemaVersion": 1,
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "id": "org.libretro." + core_name,
        "status": "build-failed",
        "sourceMapping": "unverified",
        "host": {"platform": platform.platform(), "python": sys.version},
        "scope": (
            "Fresh core and frontend compilation on Linux using SDK 3.1.46. "
            "Both outputs must match catalog pins and the exact dated archive bytes."
        ),
        "commands": [],
        "inputs": [],
        "tools": [],
        "resources": [],
        "limitations": [
            "The SDK is the pinned prebuilt distribution. "
            "Independent SDK source reconstruction remains open.",
            "An exact pair establishes this source/input recipe. "
            "Historical CI job/container identity and final-code notice scope "
            "remain separate.",
        ],
    }
    environment = dict(os.environ)
    capture = evidence / "capture"
    capture.mkdir()
    wrapper = REPOSITORY / "scripts/browser-core/capture-upstream-compiler.py"
    environment.update(
        EM_COMPILER_WRAPPER=str(wrapper),
        ECS_COMPILE_CAPTURE=str(capture),
        SOURCE_DATE_EPOCH="1793318400",
        EMCC_CORES="2",
        BINARYEN_CORES="2",
        LC_ALL="C.UTF-8",
        EMCC_DEBUG="1",
        EMCC_TEMP_DIR=str(output / "compiler-temporary"),
    )
    report["environment"] = {
        key: environment[key]
        for key in (
            "SOURCE_DATE_EPOCH",
            "EMCC_CORES",
            "BINARYEN_CORES",
            "LC_ALL",
            "EMCC_DEBUG",
            "EM_COMPILER_WRAPPER",
            "ECS_COMPILE_CAPTURE",
        )
    }

    def run(arguments, directory):
        log = evidence / f"command-{len(report['commands']) + 1:02d}.log"
        with log.open("w") as stream:
            result = subprocess.run(
                arguments,
                cwd=directory,
                env=environment,
                stdout=stream,
                stderr=subprocess.STDOUT,
            )
        report["commands"].append(
            {
                "cwd": str(directory),
                "args": arguments,
                "exitCode": result.returncode,
                "log": {"file": log.name, **file_pin(log)},
            }
        )
        if result.returncode:
            raise RuntimeError(f"Command failed. See {log.name}")
        return log.read_text()

    def download(url, destination, expected):
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(url, timeout=120) as source, destination.open(
            "xb"
        ) as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                size += len(chunk)
                if size > expected["sizeBytes"]:
                    raise RuntimeError("Downloaded input exceeds its pinned size")
                digest.update(chunk)
                target.write(chunk)
        actual = {"sha256": digest.hexdigest(), "sizeBytes": size}
        if actual != {key: expected[key] for key in ("sha256", "sizeBytes")}:
            raise RuntimeError("Downloaded input differs from its byte pin")
        report["inputs"].append({"url": url, **actual})

    try:
        mapping_path = (
            REPOSITORY / "docs/operations/upstream-binary-mapping-2026-11-06.json"
        )
        resolution_path = (
            REPOSITORY / "docs/operations/upstream-build-resolution-2026-11-06.json"
        )
        mapping = json.loads(mapping_path.read_text())
        resolution = json.loads(resolution_path.read_text())
        profile = next(p for p in mapping["profiles"] if p["id"] == report["id"])
        candidate = next(p for p in resolution["profiles"] if p["id"] == report["id"])
        if (
            candidate["candidates"][0]["coreCommit"] != sources["core"]["revision"]
            or profile["frontendRevision"]["commit"] != sources["frontend"]["revision"]
        ):
            raise RuntimeError("Dated source evidence differs from diagnostic pins")
        report["mappingEvidence"] = [
            {"file": str(path.relative_to(REPOSITORY)), **file_pin(path)}
            for path in (mapping_path, resolution_path)
        ]
        report["diagnosticScript"] = file_pin(Path(__file__))
        if (
            run(["git", "-C", str(sdk), "rev-parse", "HEAD"], output).strip()
            != SDK_REVISION
        ):
            raise RuntimeError("Pinned emsdk checkout required")
        report["sdkRevision"] = SDK_REVISION
        sdk_tools = {
            "clang": sdk / "upstream/bin/clang",
            "clang++": sdk / "upstream/bin/clang++",
            "wasm-ld": sdk / "upstream/bin/wasm-ld",
            "wasm-opt": sdk / "upstream/bin/wasm-opt",
            "node": sdk / "node/16.20.0_64bit/bin/node",
        }
        for name in (
            "emcc",
            "em++",
            "emar",
            "clang",
            "clang++",
            "wasm-ld",
            "wasm-opt",
            "node",
            "make",
            "7z",
        ):
            executable = sdk_tools.get(name) or shutil.which(
                name, path=environment["PATH"]
            )
            if not executable:
                raise RuntimeError(f"Required tool unavailable. {name}")
            path = Path(executable).resolve()
            report["tools"].append({"name": name, "path": str(path), **file_pin(path)})
        compiler_version = run(["emcc", "--version"], output)
        if COMPILER_IDENTITY not in compiler_version:
            raise RuntimeError("Pinned Emscripten compiler identity required")
        report["compilerVersion"] = compiler_version.strip()
        run([str(sdk_tools["wasm-ld"]), "--version"], output)
        run([str(sdk_tools["wasm-opt"]), "--version"], output)
        run([str(sdk_tools["node"]), "--version"], output)
        run(["make", "--version"], output)

        archive = output / "originals.7z"
        download(mapping["archive"]["url"], archive, mapping["archive"])
        originals = output / "originals"
        originals.mkdir()
        for resource in profile["resources"]:
            member = next(
                r["archiveMember"]
                for r in candidate["resources"]
                if r["file"] == resource["file"]
            )
            if member != "retroarch/" + resource["file"]:
                raise RuntimeError("Unexpected original archive member")
            # Stream the selected member into its original-resource file.
            log = evidence / f"extract-{resource['file']}.log"
            command = ["7z", "x", "-so", str(archive), member]
            with (originals / resource["file"]).open("xb") as target, log.open(
                "w"
            ) as errors:
                process = subprocess.run(command, stdout=target, stderr=errors)
            report["commands"].append(
                {
                    "cwd": str(output),
                    "args": command,
                    "exitCode": process.returncode,
                    "log": {"file": log.name, **file_pin(log)},
                }
            )
            if process.returncode or file_pin(originals / resource["file"]) != {
                key: resource[key] for key in ("sha256", "sizeBytes")
            }:
                raise RuntimeError("Original archive resource differs from catalog pin")
            report["inputs"].append(
                {"archiveMember": member, **file_pin(originals / resource["file"])}
            )

        for role, pin in sources.items():
            source_archive = output / f"{role}.tar.gz"
            url = f"https://codeload.github.com/{pin['repository']}/tar.gz/{pin['revision']}"
            download(url, source_archive, pin)
            report["inputs"][-1].update(role=role, revision=pin["revision"])
            directory = output / role
            directory.mkdir()
            with tarfile.open(source_archive) as source:
                for member in source:
                    member.name = "/".join(member.name.split("/")[1:])
                    if member.name:
                        source.extract(member, directory, filter="data")

        core = output / "core" / recipe["directory"]
        frontend = output / "frontend"
        run(
            [
                "emmake",
                "make",
                "-j2",
                "platform=emscripten",
                f"MEMORY={recipe['memoryBytes']}",
            ]
            + recipe["makeArguments"],
            core,
        )
        library = core / f"{core_name}_libretro_emscripten.bc"
        report["coreStaticLibrary"] = file_pin(library)
        shutil.copyfile(library, frontend / "libretro_emscripten.bc")
        run(
            [
                "emmake",
                "make",
                "-j2",
                "-f",
                "Makefile.emscripten",
                f"LIBRETRO={core_name}",
                f"MEMORY={recipe['memoryBytes']}",
                "GIT_VERSION=" + sources["frontend"]["revision"][:7],
            ],
            frontend,
        )
        report["resources"] = [
            compare_resource(frontend / p["file"], originals / p["file"], p)
            for p in profile["resources"]
        ]
        collector = REPOSITORY / "scripts/browser-core/compare-upstream-wasm.py"
        comparison = evidence / "runtime-comparison.json"
        try:
            run(
                [
                    sys.executable,
                    str(collector),
                    "--original-wasm",
                    str(originals / f"{core_name}_libretro.wasm"),
                    "--built-wasm",
                    str(frontend / f"{core_name}_libretro.wasm"),
                    "--original-js",
                    str(originals / f"{core_name}_libretro.js"),
                    "--built-js",
                    str(frontend / f"{core_name}_libretro.js"),
                    "--output",
                    str(comparison),
                ],
                output,
            )
            report["runtimeComparison"] = {
                "file": comparison.name,
                **file_pin(comparison),
                "collector": {
                    "file": str(collector.relative_to(REPOSITORY)),
                    **file_pin(collector),
                },
            }
        except RuntimeError as error:
            report["runtimeComparisonError"] = str(error)
        exact = len(report["resources"]) == 2 and all(
            p["originalMatchesCatalogPin"]
            and p["hashAndSizeMatch"]
            and p["directByteEquality"]
            for p in report["resources"]
        )
        report["status"] = (
            "exact-runtime-pair-reproduced" if exact else "built-pair-mismatch"
        )
    except Exception as error:
        report["error"] = str(error)
    finally:
        try:
            report["compilerInputCapture"] = capture_summary(capture, wrapper)
        except Exception as error:
            report["status"] = "build-failed"
            report["error"] = "Compiler input evidence incomplete. " + str(error)
        (evidence / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {"status": report["status"], "resources": report["resources"]}, indent=2
        )
    )
    return report["status"] == "exact-runtime-pair-reproduced"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", choices=CORE_RECIPES, default="vitaquake2")
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args()
    if arguments.self_test:
        sdk = arguments.sdk.resolve() if arguments.sdk else None
        sys.exit(0 if self_test(sdk) else 1)
    if not arguments.sdk or not arguments.output:
        parser.error("--sdk and --output are required")
    sys.exit(
        0
        if reconstruct(
            arguments.sdk.resolve(), arguments.output.resolve(), arguments.core
        )
        else 1
    )
