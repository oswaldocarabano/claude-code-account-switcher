#!/usr/bin/env python3
"""Minimal msgfmt: compile po/<lang>.po into <out>/<lang>/LC_MESSAGES/<domain>.mo.

Used because gettext's msgfmt is not installed by default on Ubuntu.
Supports msgid, msgid_plural, msgstr, msgstr[n], msgctxt and multi-line strings.
Usage: msgfmt.py <po-dir> <out-dir> <domain>
"""
import ast, os, struct, sys


def parse(path):
    entries, cur, key = [], {}, None
    def flush():
        if 'msgid' in cur:
            entries.append(dict(cur))
        cur.clear()
    for raw in open(path, encoding='utf-8'):
        line = raw.strip()
        if not line or line.startswith('#'):
            if line.startswith('#') and 'msgid' in cur and 'msgstr' in str(cur.keys()):
                pass
            continue
        if line.startswith('msgctxt'):
            flush(); key = 'msgctxt'; cur[key] = ast.literal_eval(line[7:].strip())
        elif line.startswith('msgid_plural'):
            key = 'msgid_plural'; cur[key] = ast.literal_eval(line[12:].strip())
        elif line.startswith('msgid'):
            if 'msgstr' in cur or any(k.startswith('msgstr[') for k in cur):
                flush()
            key = 'msgid'; cur[key] = ast.literal_eval(line[5:].strip())
        elif line.startswith('msgstr['):
            idx = line[7:line.index(']')]
            key = f'msgstr[{idx}]'; cur[key] = ast.literal_eval(line[line.index(']') + 1:].strip())
        elif line.startswith('msgstr'):
            key = 'msgstr'; cur[key] = ast.literal_eval(line[6:].strip())
        elif line.startswith('"') and key:
            cur[key] += ast.literal_eval(line)
    flush()
    return entries


def compile_mo(entries):
    catalog = {}
    for e in entries:
        mid = e['msgid']
        if 'msgctxt' in e:
            mid = e['msgctxt'] + '\x04' + mid
        if 'msgid_plural' in e:
            mid += '\x00' + e['msgid_plural']
            strs = [e[k] for k in sorted(k for k in e if k.startswith('msgstr['))]
            if not any(strs):
                continue
            catalog[mid] = '\x00'.join(strs)
        else:
            if not e.get('msgstr') and mid:
                continue
            catalog[mid] = e.get('msgstr', '')
    keys = sorted(catalog)
    ids = b''.join(k.encode() + b'\x00' for k in keys)
    strs = b''.join(catalog[k].encode() + b'\x00' for k in keys)
    n = len(keys)
    koff = 7 * 4
    voff = koff + n * 8
    ids_start = voff + n * 8
    strs_start = ids_start + len(ids)
    out, ko, vo, pos_i, pos_s = [], [], [], 0, 0
    for k in keys:
        kb, vb = k.encode(), catalog[k].encode()
        ko += [len(kb), ids_start + pos_i]
        vo += [len(vb), strs_start + pos_s]
        pos_i += len(kb) + 1
        pos_s += len(vb) + 1
    header = struct.pack('Iiiiiii', 0x950412de, 0, n, koff, voff, 0, 0)
    return header + struct.pack(f'{2 * n}i', *ko) + struct.pack(f'{2 * n}i', *vo) + ids + strs


def main():
    po_dir, out_dir, domain = sys.argv[1:4]
    for name in sorted(os.listdir(po_dir)):
        if not name.endswith('.po'):
            continue
        lang = name[:-3]
        dest = os.path.join(out_dir, lang, 'LC_MESSAGES')
        os.makedirs(dest, exist_ok=True)
        with open(os.path.join(dest, f'{domain}.mo'), 'wb') as f:
            f.write(compile_mo(parse(os.path.join(po_dir, name))))
        print(f'{lang}: ok')


if __name__ == '__main__':
    main()
