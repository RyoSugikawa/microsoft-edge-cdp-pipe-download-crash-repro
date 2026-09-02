from __future__ import annotations

import argparse
import struct
from pathlib import Path


EXCEPTION_STREAM = 6
MODULE_LIST_STREAM = 4


def read_u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def read_u64(data: bytes, offset: int) -> int:
    return struct.unpack_from("<Q", data, offset)[0]


def minidump_string(data: bytes, rva: int) -> str:
    byte_length = read_u32(data, rva)
    return data[rva + 4 : rva + 4 + byte_length].decode(
        "utf-16-le", errors="replace"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print the exception and owning module from a Windows minidump."
    )
    parser.add_argument("dump", type=Path)
    args = parser.parse_args()
    dump_path = args.dump.resolve()
    data = dump_path.read_bytes()

    if data[:4] != b"MDMP":
        raise ValueError(f"Not a minidump: {dump_path}")

    stream_count = read_u32(data, 8)
    directory_rva = read_u32(data, 12)
    streams: dict[int, tuple[int, int]] = {}
    for index in range(stream_count):
        entry = directory_rva + index * 12
        stream_type = read_u32(data, entry)
        data_size = read_u32(data, entry + 4)
        rva = read_u32(data, entry + 8)
        streams[stream_type] = (rva, data_size)

    exception_rva, _ = streams[EXCEPTION_STREAM]
    exception_record = exception_rva + 8
    exception_code = read_u32(data, exception_record)
    exception_address = read_u64(data, exception_record + 16)
    parameter_count = read_u32(data, exception_record + 24)
    exception_information = [
        read_u64(data, exception_record + 32 + index * 8)
        for index in range(min(parameter_count, 15))
    ]

    owning_module: tuple[str, int, int] | None = None
    module_rva, _ = streams[MODULE_LIST_STREAM]
    module_count = read_u32(data, module_rva)
    for index in range(module_count):
        module = module_rva + 4 + index * 108
        base = read_u64(data, module)
        size = read_u32(data, module + 8)
        name_rva = read_u32(data, module + 20)
        if base <= exception_address < base + size:
            owning_module = (minidump_string(data, name_rva), base, size)
            break

    print(f"dump={dump_path}")
    print(f"exception_code=0x{exception_code:08X}")
    print(f"exception_address=0x{exception_address:016X}")
    if exception_information:
        access_names = {0: "read", 1: "write", 8: "execute"}
        print(
            "access_type="
            f"{access_names.get(exception_information[0], exception_information[0])}"
        )
    if len(exception_information) >= 2:
        print(f"access_address=0x{exception_information[1]:016X}")
    if owning_module is not None:
        name, base, _ = owning_module
        print(f"module={name}")
        print(f"module_base=0x{base:016X}")
        print(f"module_offset=0x{exception_address - base:X}")


if __name__ == "__main__":
    main()
