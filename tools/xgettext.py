#!/usr/bin/env python3
"""Extract _('…') and ngettext('…', '…') from extension/ and engine/ into po/claude-account-switcher.pot
(gettext's xgettext is not installed by default). Covers the engine too. Usage: xgettext.py"""
import glob, re

def esc(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')

strings, plurals = [], []
for f in sorted(glob.glob('extension/*.js') + glob.glob('extension/lib/*.js') + glob.glob('engine/**/*.js', recursive=True)):
    s = open(f, encoding='utf-8').read()
    for m in re.finditer(r"ngettext\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'", s):
        if (m.group(1), m.group(2)) not in plurals:
            plurals.append((m.group(1), m.group(2)))
    for m in re.finditer(r"(?<![a-zA-Z])_\(\s*'((?:[^'\\]|\\.)*)'\s*\)", s):
        if m.group(1) not in strings:
            strings.append(m.group(1))
with open('po/claude-account-switcher.pot', 'w', encoding='utf-8') as out:
    out.write('msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Plural-Forms: nplurals=2; plural=(n != 1);\\n"\n\n')
    for s in strings:
        out.write(f'msgid "{esc(s)}"\nmsgstr ""\n\n')
    for a, b in plurals:
        out.write(f'msgid "{esc(a)}"\nmsgid_plural "{esc(b)}"\nmsgstr[0] ""\nmsgstr[1] ""\n\n')
print(f'{len(strings)} + {len(plurals)} plural')
