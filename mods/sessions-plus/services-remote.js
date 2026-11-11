// Fixed POSIX scripts. All selected identities remain quoted positional arguments.
export const REMOTE_SCAN = `
printf '\\n__AW_ENGINE__\\n'
if command -v docker >/dev/null 2>&1; then docker info --format '{{json .ID}}' 2>/dev/null | head -c 2000; fi
printf '\\n__AW_CONTAINERS__\\n'
if command -v docker >/dev/null 2>&1; then
 ids=$(docker ps --all --no-trunc --format '{{.ID}}' | head -n 121)
 set -- $ids
 if [ "$#" -gt 120 ]; then printf '__AW_CONTAINER_LIMIT__\\n'; ids=$(printf '%s\\n' "$ids" | head -n 120); set -- $ids; fi
 if [ "$#" -gt 0 ]; then docker inspect --format "$AW_FORMAT" -- "$@" | head -c 600001; fi
else printf '__AW_DOCKER_MISSING__\\n'; fi
printf '\\n__AW_PORTS__\\n'
if command -v ss >/dev/null 2>&1; then printf 'ss\\n'; ss -H -ltnp | head -c 600001
elif command -v lsof >/dev/null 2>&1; then printf 'lsof\\n'; lsof -nP -iTCP -sTCP:LISTEN -Fpcn | head -c 600001
else printf 'missing\\n'; fi
printf '\\n__AW_END__\\n'
`;
// Docker's compact inspect format is a fixed argv value; never sourced as shell code.
export const REMOTE_SCAN_SCRIPT = 'AW_FORMAT=$1\nshift\n' + REMOTE_SCAN;
export const REMOTE_ACTION_SCRIPT = `
action=$1; id=$2; created=$3; expected_engine=$4
command -v docker >/dev/null 2>&1 || { printf 'Docker is unavailable.\\n' >&2; exit 40; }
engine=$(docker info --format '{{json .ID}}') || exit 41
[ "$engine" = "$expected_engine" ] || { printf 'Docker engine changed. Refresh first.\\n' >&2; exit 42; }
actual=$(docker inspect --format '{{println .Id}}{{.Created}}' -- "$id") || exit 43
expected=$(printf '%s\\n%s' "$id" "$created")
[ "$actual" = "$expected" ] || { printf 'Container changed or disappeared. Refresh first.\\n' >&2; exit 44; }
case "$action" in
 restart) docker restart --time 10 -- "$id" ;;
 logs) { docker logs --timestamps --tail 300 -- "$id" 2>&1; printf '\\n__AW_LOG_RC_%s__\\n' "$?"; } | head -c 120001 ;;
 *) exit 45 ;;
esac
`;
