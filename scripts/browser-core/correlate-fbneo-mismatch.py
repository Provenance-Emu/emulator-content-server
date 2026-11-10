#!/usr/bin/env python3
"""Correlate function-shape gaps in the retained #29 FBNeo comparison."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

import ijson

BASELINE = (
    Path(__file__).resolve().parents[2]
    / "docs/operations/upstream-mismatch-resolution-2026-11-07.json"
)


def file_pin(path):
    with path.open("rb") as stream:
        return {
            "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
            "sizeBytes": path.stat().st_size,
        }


def items(path, prefix):
    with path.open("rb") as stream:
        yield from ijson.items(stream, prefix)


def summarize(path, side, unmatched):
    shapes = {}
    counts = Counter()
    incoming = defaultdict(set)
    outgoing = {}
    for entry in items(path, f"{side}Structure.functions.item"):
        index = entry["functionIndex"]
        canonical = entry["canonical"]
        shape = canonical["opcodeShapeSha256"]
        shapes[index] = shape
        counts[shape] += 1
        refs = canonical["functionReferences"]
        if index in unmatched:
            outgoing[index] = [(opcode, target) for _, opcode, target in refs]
        for ordinal, opcode, target in refs:
            if target in unmatched:
                incoming[target].add((shape, ordinal, opcode))
    if outgoing.keys() != unmatched:
        raise ValueError("Missing function record in comparison artifact")
    slots = {}
    for segment in items(path, f"{side}Structure.elements.item"):
        if segment["tableIndex"] is None or "functionIndices" not in segment:
            continue
        first = segment["offset"]["i32Value"]
        for slot, index in enumerate(segment["functionIndices"], first):
            slots[(segment["tableIndex"], slot)] = index
    return shapes, counts, incoming, outgoing, slots


def correlate(path, profile):
    gaps = profile["unmatchedStructuralPatterns"]
    original_gaps = {entry["functionIndex"] for entry in gaps["originalFunctions"]}
    built_gaps = {entry["functionIndex"] for entry in gaps["builtFunctions"]}
    old_shapes, old_counts, old_in, old_out, old_slots = summarize(
        path, "original", original_gaps
    )
    new_shapes, new_counts, new_in, new_out, new_slots = summarize(
        path, "built", built_gaps
    )

    def unique(shape):
        return shape is not None and old_counts[shape] == new_counts[shape] == 1

    evidence = []
    for old in sorted(original_gaps):
        for new in sorted(built_gaps):
            callers = sorted(
                (shape, ordinal, opcode)
                for shape, ordinal, opcode in old_in[old] & new_in[new]
                if unique(shape)
            )
            aligned_targets = []
            for ordinal, (left, right) in enumerate(zip(old_out[old], new_out[new])):
                old_opcode, old_target = left
                new_opcode, new_target = right
                shape = old_shapes.get(old_target)
                if (
                    old_opcode == new_opcode
                    and unique(shape)
                    and shape == new_shapes.get(new_target)
                ):
                    aligned_targets.append(
                        {"referenceOrdinal": ordinal, "shape": shape}
                    )
            same_reference_count = len(old_out[old]) == len(new_out[new])
            if callers or (same_reference_count and len(aligned_targets) >= 2):
                evidence.append(
                    {
                        "originalFunctionIndex": old,
                        "builtFunctionIndex": new,
                        "referenceCounts": [len(old_out[old]), len(new_out[new])],
                        "uniqueCallerSites": callers,
                        "alignedUniqueCallees": aligned_targets,
                    }
                )

    common_slots = old_slots.keys() & new_slots.keys()
    return {
        "sharedTableSlots": len(common_slots),
        "sharedTableSlotsWithMatchingNonemptyShape": sum(
            (shape := old_shapes.get(old_slots[slot])) is not None
            and shape == new_shapes.get(new_slots[slot])
            for slot in common_slots
        ),
        "sharedTableSlotsPairingTwoGaps": sum(
            old_slots[slot] in original_gaps and new_slots[slot] in built_gaps
            for slot in common_slots
        ),
        "candidateCorrespondences": evidence,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "comparison", type=Path, help="runtime-comparison.json from the recorded run"
    )
    args = parser.parse_args()
    baseline = json.loads(BASELINE.read_text())
    profile = next(p for p in baseline["profiles"] if p["id"] == "org.libretro.fbneo")
    expected = profile["hostedRun"]["runtimeComparison"]
    actual = file_pin(args.comparison)
    if any(actual[key] != expected[key] for key in actual):
        parser.error(
            "The comparison artifact does not match the recorded SHA-256 and size"
        )
    report = {
        "schemaVersion": 1,
        "input": actual,
        "scope": (
            "Static function-reference correspondence within the pinned comparison"
        ),
        **correlate(args.comparison, profile),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
