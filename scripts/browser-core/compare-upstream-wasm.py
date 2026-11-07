#!/usr/bin/env python3
"""Compare pinned runtime bytes and emit structural diagnostics.

Inputs are never rewritten.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import struct
import sys


SECTION_NAMES = {
    0: "custom",
    1: "type",
    2: "import",
    3: "function",
    4: "table",
    5: "memory",
    6: "global",
    7: "export",
    8: "start",
    9: "element",
    10: "code",
    11: "data",
    12: "data-count",
    13: "tag",
}
VALUE_TYPES = {
    0x7F: "i32",
    0x7E: "i64",
    0x7D: "f32",
    0x7C: "f64",
    0x7B: "v128",
    0x70: "funcref",
    0x6F: "externref",
}
CANONICAL_SCOPE = {
    "referenceFingerprint": (
        "Preserves the function signature, instruction opcodes, locals, branch "
        "depths, memory operands, constants and literal float bits. Replaces "
        "function references with their parameter/result signatures, type "
        "indices with signatures, and global references with value "
        "type/mutability. Function and global identity within the same "
        "signature/type can merge under this normalization."
    ),
    "layoutFingerprint": (
        "Applies reference normalization and replaces i32.const values within "
        "the module's initialized data address span and load/store offsets "
        "within that span with address markers. Other integer constants and "
        "memory offsets are preserved. Numeric values within that span can "
        "merge with addresses under this normalization."
    ),
    "opcodeShapeFingerprint": (
        "Preserves the function signature, local declarations and instruction "
        "opcode sequence, including extended subopcodes, block types and "
        "call/global type signatures. Drops other immediates. Functions with "
        "different constants, branch targets or operand indices can merge under "
        "this normalization."
    ),
    "operandMetadata": (
        "Per-function integerConstants and functionReferences are complete "
        "numeric triples [zero-based instruction ordinal, opcode, value or "
        "function index]. indirectReferences are [ordinal, opcode, type index, "
        "table index]. Ordinals count decoded instructions after local "
        "declarations. Unsupported instructions make operandMetadataComplete "
        "false."
    ),
    "purpose": (
        "Diagnostic correspondence hints. Exact resource and body byte "
        "comparisons remain independent of these fingerprints."
    ),
    "unsupportedInstructions": (
        "An unsupported instruction leaves both canonical fingerprints "
        "unavailable for that function and records its opcode and byte offset. "
        "Its exact body fingerprint remains available."
    ),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pin(path):
    data = path.read_bytes()
    return {"path": str(path), "sha256": sha(data), "sizeBytes": len(data)}


def digest_json(value):
    return sha(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


class ParseError(ValueError):
    pass


class UnsupportedInstruction(ParseError):
    pass


class Reader:
    def __init__(self, data):
        self.data = data
        self.position = 0

    def take(self, size):
        end = self.position + size
        if size < 0 or end > len(self.data):
            raise ParseError("Truncated binary at byte " + str(self.position))
        result = self.data[self.position : end]
        self.position = end
        return result

    def byte(self):
        return self.take(1)[0]

    def unsigned(self):
        result = shift = 0
        while True:
            value = self.byte()
            result |= (value & 127) << shift
            if value < 128:
                return result
            shift += 7
            if shift > 70:
                raise ParseError("Oversized unsigned LEB128")

    def signed(self):
        result = shift = 0
        while True:
            value = self.byte()
            result |= (value & 127) << shift
            shift += 7
            if value < 128:
                return result - (1 << shift) if value & 64 else result
            if shift > 70:
                raise ParseError("Oversized signed LEB128")

    def string(self):
        return self.take(self.unsigned()).decode("utf-8")

    def done(self):
        if self.position != len(self.data):
            raise ParseError("Unconsumed bytes at " + str(self.position))


def value_type(reader):
    code = reader.byte()
    if code not in VALUE_TYPES:
        raise ParseError("Unsupported value type " + hex(code))
    return VALUE_TYPES[code]


def limits(reader):
    flags = reader.unsigned()
    result = {"flags": flags, "minimum": reader.unsigned()}
    if flags & 1:
        result["maximum"] = reader.unsigned()
    return result


def global_type(reader):
    return {"type": value_type(reader), "mutable": reader.byte()}


def expression(reader):
    start = reader.position
    instructions = []
    while True:
        opcode = reader.byte()
        if opcode == 0x0B:
            break
        if opcode in (0x41, 0x42):
            instructions.append({"opcode": opcode, "value": reader.signed()})
        elif opcode in (0x23, 0xD2):
            instructions.append({"opcode": opcode, "index": reader.unsigned()})
        elif opcode == 0xD0:
            instructions.append({"opcode": opcode, "heapType": reader.signed()})
        elif opcode in (0x43, 0x44):
            instructions.append(
                {
                    "opcode": opcode,
                    "bits": reader.take(4 if opcode == 0x43 else 8).hex(),
                }
            )
        else:
            raise ParseError("Unsupported constant-expression opcode " + hex(opcode))
    value = None
    if len(instructions) == 1 and instructions[0]["opcode"] == 0x41:
        value = instructions[0]["value"] & 0xFFFFFFFF
    return {
        "instructions": instructions,
        "i32Value": value,
        "sha256": sha(reader.data[start : reader.position]),
    }


def signature(types, index):
    if index >= len(types):
        raise ParseError("Function type index outside type section")
    return types[index]


def canonical_function(
    body, function_types, types, globals_, address_span, own_signature=None
):
    reader = Reader(body)
    locals_ = []
    for _ in range(reader.unsigned()):
        locals_.append([reader.unsigned(), value_type(reader)])
    reference = hashlib.sha256()
    layout = hashlib.sha256()
    shape = hashlib.sha256()
    operand_hashes = {}
    integer_constants = []
    function_references = []
    indirect_references = []
    local_bytes = json.dumps(
        {"signature": own_signature, "locals": locals_}, separators=(",", ":")
    ).encode()
    reference.update(local_bytes)
    layout.update(local_bytes)
    shape.update(local_bytes)
    instruction_count = address_count = memory_address_count = 0
    try:
        while reader.position < len(body):
            start = reader.position
            opcode = reader.byte()
            operand_start = reader.position
            normalized = None
            address = False
            memory_layout_operand = None
            extended_subopcode = None
            if opcode in (0x02, 0x03, 0x04):
                block = reader.signed()
                if block >= 0:
                    normalized = (
                        b"type:"
                        + json.dumps(
                            signature(types, block), separators=(",", ":")
                        ).encode()
                    )
            elif opcode in (0x0C, 0x0D, 0x20, 0x21, 0x22, 0x25, 0x26):
                reader.unsigned()
            elif opcode == 0x0E:
                for _ in range(reader.unsigned() + 1):
                    reader.unsigned()
            elif opcode in (0x10, 0x12, 0xD2):
                index = reader.unsigned()
                if index >= len(function_types):
                    raise ParseError("Called function outside function index space")
                function_references.append([instruction_count, opcode, index])
                normalized = (
                    b"function-type:"
                    + json.dumps(function_types[index], separators=(",", ":")).encode()
                )
            elif opcode in (0x11, 0x13):
                type_index = reader.unsigned()
                table_index = reader.unsigned()
                indirect_references.append(
                    [instruction_count, opcode, type_index, table_index]
                )
                normalized = (
                    b"indirect:"
                    + json.dumps(
                        [signature(types, type_index), table_index],
                        separators=(",", ":"),
                    ).encode()
                )
            elif opcode == 0x1C:
                for _ in range(reader.unsigned()):
                    value_type(reader)
            elif opcode in (0x23, 0x24):
                index = reader.unsigned()
                if index >= len(globals_):
                    raise ParseError("Global reference outside global index space")
                normalized = (
                    b"global-type:"
                    + json.dumps(
                        globals_[index], sort_keys=True, separators=(",", ":")
                    ).encode()
                )
            elif 0x28 <= opcode <= 0x3E:
                alignment = reader.unsigned()
                offset = reader.unsigned()
                if address_span and address_span[0] <= offset < address_span[1]:
                    memory_layout_operand = json.dumps(
                        [alignment, "initialized-data-address"]
                    ).encode()
            elif opcode in (0x3F, 0x40):
                reader.unsigned()
            elif opcode in (0x41, 0x42):
                value = reader.signed()
                integer_constants.append([instruction_count, opcode, value])
                if opcode == 0x41 and address_span:
                    address = address_span[0] <= (value & 0xFFFFFFFF) < address_span[1]
            elif opcode in (0x43, 0x44):
                reader.take(4 if opcode == 0x43 else 8)
            elif opcode == 0xD0:
                reader.signed()
            elif opcode == 0xFC:
                subopcode = reader.unsigned()
                extended_subopcode = subopcode
                if subopcode <= 7:
                    pass
                elif subopcode in (8, 10, 12, 14):
                    reader.unsigned()
                    reader.unsigned()
                elif subopcode in (9, 11, 13, 15, 16, 17):
                    reader.unsigned()
                else:
                    raise UnsupportedInstruction(
                        "Unsupported 0xfc instruction "
                        + str(subopcode)
                        + " at body byte "
                        + str(start)
                    )
            elif (
                opcode in (0x00, 0x01, 0x05, 0x0B, 0x0F, 0x1A, 0x1B, 0xD1)
                or 0x45 <= opcode <= 0xC4
            ):
                pass
            else:
                raise UnsupportedInstruction(
                    "Unsupported opcode " + hex(opcode) + " at body byte " + str(start)
                )
            raw_operand = body[operand_start : reader.position]
            operand = normalized if normalized is not None else raw_operand
            token = bytes([opcode]) + operand
            reference.update(struct.pack("<I", len(token)) + token)
            if address:
                token = bytes([opcode]) + b"initialized-data-address"
                address_count += 1
            if memory_layout_operand is not None:
                token = bytes([opcode]) + memory_layout_operand
                memory_address_count += 1
            layout.update(struct.pack("<I", len(token)) + token)
            if opcode in (
                0x02,
                0x03,
                0x04,
                0x10,
                0x11,
                0x12,
                0x13,
                0x1C,
                0x23,
                0x24,
                0xD0,
                0xD2,
            ):
                shape_operand = operand
            elif extended_subopcode is not None:
                shape_operand = str(extended_subopcode).encode()
            else:
                shape_operand = b""
            shape_token = bytes([opcode]) + shape_operand
            shape.update(struct.pack("<I", len(shape_token)) + shape_token)
            category = None
            if opcode in (0x02, 0x03, 0x04, 0x1C, 0xD0):
                category = "type"
            elif opcode in (0x10, 0x11, 0x12, 0x13, 0xD2):
                category = "function-reference"
            elif opcode in (0x23, 0x24):
                category = "global-reference"
            elif opcode in (0x20, 0x21, 0x22):
                category = "local-index"
            elif opcode in (0x0C, 0x0D, 0x0E):
                category = "branch-target"
            elif 0x28 <= opcode <= 0x40:
                category = "memory-operand"
            elif opcode in (0x41, 0x42):
                category = "integer-constant"
            elif opcode in (0x43, 0x44):
                category = "float-constant"
            elif raw_operand:
                category = "other"
            if category:
                if category not in operand_hashes:
                    operand_hashes[category] = hashlib.sha256()
                operand_hash = operand_hashes[category]
                raw_token = bytes([opcode]) + raw_operand
                operand_hash.update(struct.pack("<I", len(raw_token)) + raw_token)
            instruction_count += 1
    except UnsupportedInstruction as error:
        return {
            "status": "unsupported-instruction",
            "error": str(error),
            "referenceSha256": None,
            "layoutSha256": None,
            "opcodeShapeSha256": None,
            "operandMetadataComplete": False,
            "integerConstants": integer_constants,
            "functionReferences": function_references,
            "indirectReferences": indirect_references,
        }
    return {
        "status": "complete",
        "referenceSha256": reference.hexdigest(),
        "layoutSha256": layout.hexdigest(),
        "opcodeShapeSha256": shape.hexdigest(),
        "operandMetadataComplete": True,
        "integerConstants": integer_constants,
        "functionReferences": function_references,
        "indirectReferences": indirect_references,
        "operandCategorySha256": {
            key: value.hexdigest() for key, value in sorted(operand_hashes.items())
        },
        "normalizedMemoryAddressOffsetCount": memory_address_count,
        "instructionCount": instruction_count,
        "normalizedDataAddressCount": address_count,
    }


def parse_module(data):
    reader = Reader(data)
    if reader.take(8) != b"\0asm\x01\0\0\0":
        raise ParseError("Expected WebAssembly binary version 1")
    sections = []
    payloads = {}
    custom_names = []
    while reader.position < len(data):
        offset = reader.position
        section_id = reader.byte()
        payload = reader.take(reader.unsigned())
        item = {
            "id": section_id,
            "name": SECTION_NAMES.get(section_id, "unknown"),
            "offset": offset,
            "payloadBytes": len(payload),
            "sha256": sha(payload),
        }
        if section_id == 0:
            custom_name = Reader(payload).string()
            item["customName"] = custom_name
            custom_names.append(custom_name)
        else:
            if section_id in payloads:
                raise ParseError("Duplicate non-custom section")
            payloads[section_id] = payload
        sections.append(item)
    types = []
    if 1 in payloads:
        part = Reader(payloads[1])
        for _ in range(part.unsigned()):
            if part.byte() != 0x60:
                raise ParseError("Only function types are supported")
            types.append(
                {
                    "params": [value_type(part) for _ in range(part.unsigned())],
                    "results": [value_type(part) for _ in range(part.unsigned())],
                }
            )
        part.done()
    imports = []
    function_types = []
    globals_ = []
    if 2 in payloads:
        part = Reader(payloads[2])
        for _ in range(part.unsigned()):
            item = {"module": part.string(), "name": part.string(), "kind": part.byte()}
            if item["kind"] == 0:
                item["typeIndex"] = part.unsigned()
                item["signature"] = signature(types, item["typeIndex"])
                function_types.append(item["signature"])
            elif item["kind"] == 1:
                item["elementType"] = value_type(part)
                item["limits"] = limits(part)
            elif item["kind"] == 2:
                item["limits"] = limits(part)
            elif item["kind"] == 3:
                item["globalType"] = global_type(part)
                globals_.append(item["globalType"])
            elif item["kind"] == 4:
                item["attribute"] = part.byte()
                item["typeIndex"] = part.unsigned()
            else:
                raise ParseError("Unknown import kind")
            imports.append(item)
        part.done()
    imported_function_count = len(function_types)
    definitions = []
    if 3 in payloads:
        part = Reader(payloads[3])
        definitions = [part.unsigned() for _ in range(part.unsigned())]
        function_types.extend(signature(types, index) for index in definitions)
        part.done()
    global_records = []
    if 6 in payloads:
        part = Reader(payloads[6])
        for _ in range(part.unsigned()):
            item = {"globalType": global_type(part), "initializer": expression(part)}
            globals_.append(item["globalType"])
            global_records.append(item)
        part.done()
    exports = []
    if 7 in payloads:
        part = Reader(payloads[7])
        for _ in range(part.unsigned()):
            item = {
                "name": part.string(),
                "kind": part.byte(),
                "index": part.unsigned(),
            }
            if item["kind"] == 0:
                item["signature"] = function_types[item["index"]]
            exports.append(item)
        part.done()
    segments = []
    ascii_strings = Counter()
    if 11 in payloads:
        part = Reader(payloads[11])
        for _ in range(part.unsigned()):
            flags = part.unsigned()
            item = {"flags": flags, "memoryIndex": None, "offset": None}
            if flags in (0, 2):
                item["memoryIndex"] = part.unsigned() if flags == 2 else 0
                item["offset"] = expression(part)
            elif flags != 1:
                raise ParseError("Unsupported data-segment flags")
            payload = part.take(part.unsigned())
            item.update({"payloadBytes": len(payload), "payloadSha256": sha(payload)})
            segments.append(item)
            ascii_strings.update(
                match.group() for match in re.finditer(rb"[ -~]{5,}", payload)
            )
        part.done()
    active = [
        (segment["offset"]["i32Value"], segment["payloadBytes"])
        for segment in segments
        if segment["offset"] and segment["offset"]["i32Value"] is not None
    ]
    address_span = (
        [
            min(offset for offset, size in active),
            max(offset + size for offset, size in active),
        ]
        if active
        else None
    )
    functions = []
    if 10 in payloads:
        part = Reader(payloads[10])
        body_count = part.unsigned()
        if body_count != len(definitions):
            raise ParseError("Function and code section counts differ")
        for index in range(body_count):
            body = part.take(part.unsigned())
            functions.append(
                {
                    "functionIndex": imported_function_count + index,
                    "definedIndex": index,
                    "bodyBytes": len(body),
                    "bodySha256": sha(body),
                    "signature": signature(types, definitions[index]),
                    "canonical": canonical_function(
                        body,
                        function_types,
                        types,
                        globals_,
                        address_span,
                        signature(types, definitions[index]),
                    ),
                }
            )
        part.done()
    elements = []
    if 9 in payloads:
        part = Reader(payloads[9])
        for _ in range(part.unsigned()):
            flags = part.unsigned()
            item = {"flags": flags, "tableIndex": None, "offset": None}
            if flags in (0, 2, 4, 6):
                item["tableIndex"] = part.unsigned() if flags in (2, 6) else 0
                item["offset"] = expression(part)
            elif flags not in (1, 3, 5, 7):
                raise ParseError("Unsupported element-segment flags")
            if flags in (1, 2, 3):
                item["elementKind"] = part.byte()
            elif flags in (5, 6, 7):
                item["elementType"] = value_type(part)
            count = part.unsigned()
            if flags <= 3:
                indices = [part.unsigned() for _ in range(count)]
                item["functionIndices"] = indices
                item["signatureSequenceSha256"] = digest_json(
                    [function_types[index] for index in indices]
                )
            else:
                item["initializers"] = [expression(part) for _ in range(count)]
            item["entryCount"] = count
            elements.append(item)
        part.done()
    return {
        "sections": sections,
        "nameSectionPresent": "name" in custom_names,
        "customSectionNames": custom_names,
        "types": types,
        "imports": imports,
        "exports": exports,
        "globals": global_records,
        "elements": elements,
        "importedFunctionCount": imported_function_count,
        "functions": functions,
        "data": {
            "segmentCount": len(segments),
            "payloadBytes": sum(item["payloadBytes"] for item in segments),
            "initializedAddressSpan": address_span,
            "segments": segments,
        },
    }, ascii_strings


def counter_comparison(original, built, sample_limit=80):
    original_only = original - built
    built_only = built - original

    def sample(counter):
        return [
            {
                "sha256": sha(value),
                "lengthBytes": len(value),
                "count": count,
                "text": value[:256].decode("ascii"),
                "textTruncated": len(value) > 256,
            }
            for value, count in sorted(counter.items())[:sample_limit]
        ]

    return {
        "equal": original == built,
        "originalOccurrences": sum(original.values()),
        "builtOccurrences": sum(built.values()),
        "originalDistinct": len(original),
        "builtDistinct": len(built),
        "originalOnlyOccurrences": sum(original_only.values()),
        "builtOnlyOccurrences": sum(built_only.values()),
        "originalOnlyDistinct": len(original_only),
        "builtOnlyDistinct": len(built_only),
        "sampleLimit": sample_limit,
        "originalOnlySample": sample(original_only),
        "builtOnlySample": sample(built_only),
    }


def histogram(values):
    return Counter(
        json.dumps(value, sort_keys=True, separators=(",", ":")) for value in values
    )


def function_comparison(original, built):
    first, second = original["functions"], built["functions"]
    result = {
        "originalDefinedFunctionCount": len(first),
        "builtDefinedFunctionCount": len(second),
        "sameDefinedIndexExactBodyCount": sum(
            a["bodySha256"] == b["bodySha256"] for a, b in zip(first, second)
        ),
        "bodyLengthMultisetsEqual": Counter(item["bodyBytes"] for item in first)
        == Counter(item["bodyBytes"] for item in second),
        "exactBodyHashMultisetsEqual": Counter(item["bodySha256"] for item in first)
        == Counter(item["bodySha256"] for item in second),
    }
    for field in ("referenceSha256", "layoutSha256", "opcodeShapeSha256"):
        a = Counter(
            item["canonical"][field] for item in first if item["canonical"][field]
        )
        b = Counter(
            item["canonical"][field] for item in second if item["canonical"][field]
        )
        result[field] = {
            "originalCompletedCount": sum(a.values()),
            "builtCompletedCount": sum(b.values()),
            "multisetsEqual": (
                a == b
                if sum(a.values()) == len(first) and sum(b.values()) == len(second)
                else None
            ),
            "originalUnmatchedOccurrences": sum((a - b).values()),
            "builtUnmatchedOccurrences": sum((b - a).values()),
        }
    groups = []
    for functions in (first, second):
        by_shape = {}
        for function in functions:
            shape_hash = function["canonical"]["opcodeShapeSha256"]
            if shape_hash:
                by_shape.setdefault(shape_hash, []).append(function)
        groups.append(by_shape)
    changed_categories = Counter()
    samples = []
    unique_pairs = 0
    for shape_hash in sorted(set(groups[0]) & set(groups[1])):
        a, b = groups[0][shape_hash], groups[1][shape_hash]
        if len(a) != 1 or len(b) != 1:
            continue
        unique_pairs += 1
        before, after = (
            a[0]["canonical"]["operandCategorySha256"],
            b[0]["canonical"]["operandCategorySha256"],
        )
        changed = [
            key
            for key in sorted(set(before) | set(after))
            if before.get(key) != after.get(key)
        ]
        changed_categories.update(changed)
        if changed and len(samples) < 80:
            samples.append(
                {
                    "originalFunctionIndex": a[0]["functionIndex"],
                    "builtFunctionIndex": b[0]["functionIndex"],
                    "changedOperandCategories": changed,
                }
            )
    result["uniqueOpcodeShapePairs"] = {
        "pairCount": unique_pairs,
        "pairsWithDifferentOperandCategoryHashes": dict(changed_categories),
        "sampleLimit": 80,
        "changedPairSample": samples,
    }
    return result


def compare_javascript(original_path, built_path):
    a, b = original_path.read_bytes(), built_path.read_bytes()
    ranges = []
    start = None
    differences = 0
    for index in range(max(len(a), len(b))):
        differs = index >= len(a) or index >= len(b) or a[index] != b[index]
        differences += differs
        if differs and start is None:
            start = index
        if start is not None and (not differs or index == max(len(a), len(b)) - 1):
            end = index if not differs else index + 1
            if len(ranges) < 80:
                left, right = max(0, start - 60), end + 60
                ranges.append(
                    {
                        "start": start,
                        "end": end,
                        "originalContext": a[left:right][:280].decode(
                            "utf-8", errors="replace"
                        ),
                        "builtContext": b[left:right][:280].decode(
                            "utf-8", errors="replace"
                        ),
                    }
                )
            start = None
    return {
        "original": pin(original_path),
        "built": pin(built_path),
        "directByteEquality": a == b,
        "alignedByteDifferenceCount": differences,
        "spanSampleLimit": 80,
        "differingSpanSample": ranges,
    }


def compare(original_path, built_path, original_js=None, built_js=None):
    original_bytes, built_bytes = original_path.read_bytes(), built_path.read_bytes()
    original, original_strings = parse_module(original_bytes)
    built, built_strings = parse_module(built_bytes)
    original_sections = {
        item["id"]: item for item in original["sections"] if item["id"]
    }
    built_sections = {item["id"]: item for item in built["sections"] if item["id"]}
    section_comparison = [
        {
            "id": key,
            "name": SECTION_NAMES.get(key, "unknown"),
            "originalPayloadBytes": original_sections.get(key, {}).get("payloadBytes"),
            "builtPayloadBytes": built_sections.get(key, {}).get("payloadBytes"),
            "payloadHashesEqual": original_sections.get(key, {}).get("sha256")
            == built_sections.get(key, {}).get("sha256"),
        }
        for key in sorted(set(original_sections) | set(built_sections))
    ]
    result = {
        "schemaVersion": 1,
        "collector": pin(Path(__file__).resolve()),
        "scope": (
            "Structural and ASCII diagnostics of the supplied exact runtime bytes. "
            "This collector reads files and computes fingerprints without rewriting "
            "inputs."
        ),
        "canonicalizationScope": CANONICAL_SCOPE,
        "wasm": {
            "original": pin(original_path),
            "built": pin(built_path),
            "directByteEquality": original_bytes == built_bytes,
            "sections": section_comparison,
            "functions": function_comparison(original, built),
            "typeSignatureMultisetsEqual": histogram(original["types"])
            == histogram(built["types"]),
            "importSignatureMultisetsEqual": histogram(
                item.get(
                    "signature",
                    {
                        key: value
                        for key, value in item.items()
                        if key not in ("name", "module")
                    },
                )
                for item in original["imports"]
            )
            == histogram(
                item.get(
                    "signature",
                    {
                        key: value
                        for key, value in item.items()
                        if key not in ("name", "module")
                    },
                )
                for item in built["imports"]
            ),
            "dataPayloadAscii": counter_comparison(original_strings, built_strings),
        },
        "originalStructure": original,
        "builtStructure": built,
    }
    if original_js and built_js:
        result["javascript"] = compare_javascript(original_js, built_js)
    return result


def self_test():
    import tempfile
    import unittest

    def unsigned(value):
        result = bytearray()
        while value >= 128:
            result.append((value & 127) | 128)
            value >>= 7
        return bytes(result) + bytes([value])

    def section(kind, payload):
        return bytes([kind]) + unsigned(len(payload)) + payload

    def fixture(reordered=False):
        bodies = [b"\0\x41\x80\x08\x0b", b"\0\x10\0\x0b"]
        offset = b"\x80\x08"
        indices = b"\0\x01"
        if reordered:
            bodies = [b"\0\x10\x01\x0b", b"\0\x41\x80\x10\x0b"]
            offset = b"\x80\x10"
            indices = b"\x01\0"
        return (
            b"\0asm\x01\0\0\0"
            + section(1, b"\x01\x60\0\x01\x7f")
            + section(3, b"\x02\0\0")
            + section(4, b"\x01\x70\0\x02")
            + section(5, b"\x01\0\x01")
            + section(9, b"\x01\0\x41\0\x0b\x02" + indices)
            + section(
                10, b"\x02" + b"".join(unsigned(len(body)) + body for body in bodies)
            )
            + section(11, b"\x01\0\x41" + offset + b"\x0b\x0b" + b"alpha\0beta\0")
        )

    class CollectorTests(unittest.TestCase):
        def test_reference_and_address_normalizations_are_distinct(self):
            original, strings = parse_module(fixture())
            built, other_strings = parse_module(fixture(True))
            summary = function_comparison(original, built)
            self.assertFalse(summary["exactBodyHashMultisetsEqual"])
            self.assertFalse(summary["referenceSha256"]["multisetsEqual"])
            self.assertTrue(summary["layoutSha256"]["multisetsEqual"])
            self.assertTrue(summary["bodyLengthMultisetsEqual"])
            self.assertEqual(strings, other_strings)
            self.assertEqual(
                original["elements"][0]["signatureSequenceSha256"],
                built["elements"][0]["signatureSequenceSha256"],
            )

        def test_import_global_export_and_name_sections(self):
            module = (
                b"\0asm\x01\0\0\0"
                + section(1, b"\x01\x60\0\x01\x7f")
                + section(2, b"\x02\x03env\x01f\0\0\x03env\x01g\x03\x7f\0")
                + section(3, b"\x01\0")
                + section(6, b"\x01\x7f\x01\x41\x10\x0b")
                + section(7, b"\x02\x03run\0\x01\x01g\x03\x01")
                + section(10, b"\x01\x04\0\x10\0\x0b")
                + section(0, b"\x04name")
            )
            parsed, _ = parse_module(module)
            self.assertTrue(parsed["nameSectionPresent"])
            self.assertEqual(parsed["importedFunctionCount"], 1)
            self.assertEqual(parsed["functions"][0]["functionIndex"], 1)
            self.assertEqual(
                parsed["functions"][0]["canonical"]["functionReferences"], [[0, 16, 0]]
            )
            self.assertEqual(
                parsed["exports"][0]["signature"], {"params": [], "results": ["i32"]}
            )
            self.assertEqual(parsed["globals"][0]["initializer"]["i32Value"], 16)

        def test_static_memory_offsets_are_normalized_separately(self):
            a = canonical_function(
                b"\0\x41\0\x28\x02\x80\x08\x0b", [], [], [], [1024, 1035]
            )
            b = canonical_function(
                b"\0\x41\0\x28\x02\x80\x10\x0b", [], [], [], [2048, 2059]
            )
            self.assertNotEqual(a["referenceSha256"], b["referenceSha256"])
            self.assertEqual(a["layoutSha256"], b["layoutSha256"])
            self.assertEqual(a["opcodeShapeSha256"], b["opcodeShapeSha256"])
            self.assertEqual(a["normalizedMemoryAddressOffsetCount"], 1)
            self.assertEqual(a["integerConstants"], [[0, 65, 0]])
            self.assertTrue(a["operandMetadataComplete"])
            self.assertNotEqual(
                a["operandCategorySha256"]["memory-operand"],
                b["operandCategorySha256"]["memory-operand"],
            )

        def test_data_ascii_ignores_section_headers_and_offsets(self):
            original, strings = parse_module(fixture())
            self.assertEqual(strings, Counter({b"alpha": 1}))
            self.assertEqual(original["data"]["initializedAddressSpan"], [1024, 1035])

        def test_unsupported_instruction_preserves_exact_body(self):
            result = canonical_function(b"\0\xfd\0\x0b", [], [], [], None)
            self.assertEqual(result["status"], "unsupported-instruction")
            self.assertIsNone(result["referenceSha256"])
            empty = {
                "functions": [{"bodySha256": "x", "bodyBytes": 4, "canonical": result}]
            }
            self.assertIsNone(
                function_comparison(empty, empty)["referenceSha256"]["multisetsEqual"]
            )
            with self.assertRaises(ParseError):
                parse_module(fixture()[:-1])

        def test_js_differences_and_input_bytes(self):
            with tempfile.TemporaryDirectory() as directory:
                original = Path(directory) / "a.js"
                built = Path(directory) / "b.js"
                original.write_bytes(b"let x=1;")
                built.write_bytes(b"let x=2;")
                result = compare_javascript(original, built)
                self.assertEqual(result["alignedByteDifferenceCount"], 1)
                self.assertEqual(result["differingSpanSample"][0]["start"], 6)
                self.assertEqual(original.read_bytes(), b"let x=1;")

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CollectorTests)
    return unittest.TextTestRunner().run(suite).wasSuccessful()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-wasm", type=Path)
    parser.add_argument("--built-wasm", type=Path)
    parser.add_argument("--original-js", type=Path)
    parser.add_argument("--built-js", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return 0 if self_test() else 1
    if not args.original_wasm or not args.built_wasm or not args.output:
        parser.error("Both WASM files and --output are required")
    if bool(args.original_js) != bool(args.built_js):
        parser.error("Supply both JavaScript files together")
    result = compare(
        args.original_wasm, args.built_wasm, args.original_js, args.built_js
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Stream compact metadata because full numeric operand inventories can be large.
    with args.output.open("w") as target:
        json.dump(result, target, separators=(",", ":"))
        target.write("\n")
    print(
        json.dumps(
            {
                "wasm": {
                    key: value
                    for key, value in result["wasm"]["functions"].items()
                    if key != "uniqueOpcodeShapePairs"
                },
                "uniqueOpcodeShapePairCount": result["wasm"]["functions"][
                    "uniqueOpcodeShapePairs"
                ]["pairCount"],
                "changedOperandCategoryCounts": result["wasm"]["functions"][
                    "uniqueOpcodeShapePairs"
                ]["pairsWithDifferentOperandCategoryHashes"],
                "asciiEqual": result["wasm"]["dataPayloadAscii"]["equal"],
                "javascriptEqual": result.get("javascript", {}).get(
                    "directByteEquality"
                ),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
