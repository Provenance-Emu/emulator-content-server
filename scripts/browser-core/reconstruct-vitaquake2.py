#!/usr/bin/env python3
"""Fresh Linux reconstruction of the dated VitaQuake2 pair, retaining evidence."""

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


def self_test():
    import tempfile
    import unittest

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

    return (
        unittest.TextTestRunner()
        .run(unittest.defaultTestLoader.loadTestsFromTestCase(ComparisonTests))
        .wasSuccessful()
    )


def reconstruct(sdk, output):
    output.mkdir()  # Exclusive workspace preserves any previous diagnostic attempt.
    evidence = output / "evidence"
    evidence.mkdir()
    report = {
        "schemaVersion": 1,
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "id": "org.libretro.vitaquake2",
        "status": "build-failed",
        "sourceMapping": "unverified",
        "host": {"platform": platform.platform(), "python": sys.version},
        "scope": "Fresh core and frontend compilation on Linux using SDK 3.1.46. Both outputs must match catalog pins and the exact dated archive bytes.",
        "commands": [],
        "inputs": [],
        "tools": [],
        "resources": [],
        "limitations": [
            "The SDK is the pinned prebuilt distribution. Independent SDK source reconstruction remains open.",
            "An exact pair establishes this source/input recipe. Historical CI job/container identity and final-code notice scope remain separate.",
        ],
    }
    environment = dict(os.environ)
    environment.update(
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
            candidate["candidates"][0]["coreCommit"]
            != SOURCE_ARCHIVES["core"]["revision"]
            or profile["frontendRevision"]["commit"]
            != SOURCE_ARCHIVES["frontend"]["revision"]
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
            "wasm-ld": sdk / "upstream/bin/wasm-ld",
            "wasm-opt": sdk / "upstream/bin/wasm-opt",
            "node": sdk / "node/16.20.0_64bit/bin/node",
        }
        for name in (
            "emcc",
            "em++",
            "emar",
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
            # Stream just the selected member. Other emulator resources remain compressed.
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

        for role, pin in SOURCE_ARCHIVES.items():
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

        core = output / "core"
        frontend = output / "frontend"
        run(
            [
                "emmake",
                "make",
                "-j2",
                "platform=emscripten",
                "MEMORY=402653184",
                'GIT_VERSION=" 4b333fe"',
            ],
            core,
        )
        library = core / "vitaquake2_libretro_emscripten.bc"
        report["coreStaticLibrary"] = file_pin(library)
        shutil.copyfile(library, frontend / "libretro_emscripten.bc")
        run(
            [
                "emmake",
                "make",
                "-j2",
                "-f",
                "Makefile.emscripten",
                "LIBRETRO=vitaquake2",
                "MEMORY=402653184",
                "GIT_VERSION=6ebf66b",
            ],
            frontend,
        )
        report["resources"] = [
            compare_resource(frontend / p["file"], originals / p["file"], p)
            for p in profile["resources"]
        ]
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
        (evidence / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {"status": report["status"], "resources": report["resources"]}, indent=2
        )
    )
    return report["status"] == "exact-runtime-pair-reproduced"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args()
    if arguments.self_test:
        sys.exit(0 if self_test() else 1)
    if not arguments.sdk or not arguments.output:
        parser.error("--sdk and --output are required")
    sys.exit(
        0 if reconstruct(arguments.sdk.resolve(), arguments.output.resolve()) else 1
    )
