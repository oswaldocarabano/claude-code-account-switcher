#!/usr/bin/env python3
"""Remove text/time metadata chunks (tEXt, zTXt, iTXt, tIME, eXIf) from PNG files.
Screenshots embed the creation time with the local UTC offset; strip it before publishing.
Usage: strip-png-metadata.py <file.png>..."""
import struct, sys

DROP = {b'tEXt', b'zTXt', b'iTXt', b'tIME', b'eXIf'}
for path in sys.argv[1:]:
    data = open(path, 'rb').read()
    out, i = bytearray(data[:8]), 8
    while i < len(data):
        n, kind = struct.unpack('>I4s', data[i:i + 8])
        if kind not in DROP:
            out += data[i:i + 12 + n]
        i += 12 + n
    open(path, 'wb').write(out)
