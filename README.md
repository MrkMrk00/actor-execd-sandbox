# Code Sandbox (OpenSandbox execd)

Apify Standby Actor that runs the [OpenSandbox](https://open-sandbox.ai)
[`execd`](https://open-sandbox.ai/architecture/data-plane/execd) daemon and
exposes its HTTP API. Use it as a code execution sandbox for AI agents: run
shell commands, execute code in persistent kernels, read and write files,
open interactive terminals.

Every Standby run is a fresh container. State (files, kernels, background
commands) lives only for the lifetime of that run.

## What is inside

- `execd` v1.1.0 (binary and native helpers taken from `opensandbox/execd:v1.1.0`)
- Debian trixie with Python 3.14 (via uv), Node.js 26, Bash, git, curl, jq,
  build-essential
- Jupyter server on loopback with kernels for `python`, `javascript`,
  `typescript` (tslab) and `bash`
- Runs as the unprivileged `sandbox` user, working directory `/workspace`

## Calling the API

All requests go to the Actor's Standby URL and need an Apify API token:

```bash
BASE=https://<your-username>--actor-execd-sandbox.apify.actor
TOKEN=<apify token>

# health
curl -H "Authorization: Bearer $TOKEN" "$BASE/ping"

# shell command (SSE stream of stdout/stderr/exit)
curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"command":"echo hello && uname -a"}' "$BASE/command"

# run Python in a persistent kernel (SSE stream); state survives between calls
curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"context":{"language":"python"},"code":"x = 41\nprint(x)"}' "$BASE/code"
curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"context":{"language":"python"},"code":"x + 1"}' "$BASE/code"

# or create an explicit context and pass its id
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"language":"javascript"}' "$BASE/code/context"
# -> {"id":"<ctx>","language":"javascript"}
curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"context":{"id":"<ctx>","language":"javascript"},"code":"console.log(1+1)"}' "$BASE/code"

# upload a file: a JSON metadata part followed by the file part
echo '{"path":"/workspace/local.txt"}' > meta.json
curl -H "Authorization: Bearer $TOKEN" \
  -F 'metadata=@meta.json;type=application/json' -F 'file=@local.txt' \
  "$BASE/files/upload"

# download it back
curl -H "Authorization: Bearer $TOKEN" "$BASE/files/download?path=/workspace/local.txt"
```

Supported `language` values for `/code`: `python`, `javascript`, `typescript`,
`bash`. A `/code` request without `context` runs the code as a shell command.

The complete endpoint list with request and response schemas is in the
**Endpoints** tab of the Actor (rendered from `.actor/web_server_openapi.json`,
which mirrors the upstream [execd API spec](https://open-sandbox.ai/api/)).
Main groups:

| Path prefix       | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `/command`        | Foreground (SSE) and background shell commands             |
| `/code`, `/session` | Code execution in Jupyter kernels, contexts, bash sessions |
| `/files`, `/directories` | Upload, download, list, move, chmod, search, replace |
| `/pty`            | Interactive terminal over WebSocket                        |
| `/metrics`        | CPU and memory snapshot and stream                         |
| `/v1/isolated`    | Per-run bubblewrap namespaces (reported as unsupported if the host forbids user namespaces) |
| `/proxy/{port}`   | Reverse proxy to a port inside the sandbox                 |

The OpenSandbox SDKs (Python, JS, Go, Java, C#) can talk to this Actor
directly; point them at the Standby URL and send the Apify token in the
`Authorization` header.

## Configuration

Environment variables you can set on the Actor:

| Variable             | Default   | Meaning                                                                   |
| -------------------- | --------- | ------------------------------------------------------------------------- |
| `EXECD_ACCESS_TOKEN` | unset     | If set, every request must also carry `X-EXECD-ACCESS-TOKEN: <value>`. Mark it as Secret. |
| `EXECD_ISOLATION_CONFIG` | unset | Path to an isolation TOML (see upstream `configs/`) to tune bubblewrap sessions. |
| `JUPYTER_PORT`       | `44771`   | Loopback port of the internal Jupyter server.                             |

Apify sets `ACTOR_WEB_SERVER_PORT`; the entrypoint passes it to `execd --port`.

## Running locally

```bash
docker build -t execd-sandbox .
docker run --rm -p 44772:44772 execd-sandbox
curl localhost:44772/ping
```

## Notes

- Standby routes requests to any warm run. Do not assume two requests hit
  the same container unless you use the same run's Standby URL from the run
  object.
- The platform's readiness probe hits `GET /`, which execd answers with 404.
  Apify documents that any response marks the run ready; if runs never
  become ready, this is the first thing to check.
- `execd` runs as PID 1 (`--init`) and supervises the Jupyter server; if the
  Jupyter server dies the run exits so the platform can replace it.
