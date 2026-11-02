#!/bin/sh
# Kill leftover fake processes from tests (fakeApi/fakeClaude/fakeClaudeCode).
ps -eo pid=,args= | awk '$2=="gjs" && $3=="-m" && $4 ~ /tests\/fake(Api|Claude|ClaudeCode)\.js$/ {print $1}' | xargs -r kill 2>/dev/null
exit 0
