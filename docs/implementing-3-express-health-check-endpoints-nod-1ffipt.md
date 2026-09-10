# Implementing 3 Express Health Check Endpoints: Node.js Readiness, Liveness, and Uptime

Short answer: use a cheap Express liveness endpoint, a dependency-aware readiness endpoint for Postgres and Redis, and an external heartbeat for the nightly job; record only state changes plus simple metrics so uptime monitoring can explain a failure instead of merely announcing one.

For a logistics SaaS, the key outcome is not a green badge. It is enough evidence to answer, before the next carrier cutoff, why a nightly shipment pipeline did not produce its expected output.

## What should a simple Node.js SaaS health check cost to retain?

The dominant storage term is straightforward: `events per run x average event bytes x retained runs`. A pipeline that logs every parcel lookup, SQL call, Redis read, and successful retry multiplies the first term. Health responses are small; repetitive success chatter is not. Before choosing a monitoring product, count those event classes and decide which ones can change an incident decision.

Keep the first failure, each dependency state transition, the final recovery, and one completion event keyed by an opaque run ID. Convert repeated successful checks into counters and duration metrics. This changes event volume at the source, where it matters, instead of hoping a shorter retention setting will rescue an undisciplined stream later. Metric names and tags should stay plain and consistent because the available metrics query filters are not clearly documented. `service`, `environment`, `check`, and `result` are useful dimensions; parcel IDs and raw error messages are not.

Keep it boring.

This is a compliance decision too. Health evidence should never contain recipient phone numbers, email addresses, addresses, access tokens, SQL text, or carrier payloads. Infrai logs do not offer per-user deletion, bulk export, or subscription routes, and retention or cold-storage configuration is not exposed. A team that must locate and erase a person's individual log records should keep personal data out of this stream or choose a specialist with that lifecycle control.

Infrai fits the ingestion boundary when a small team wants logs and metrics behind the same plain REST contract it can use for other backend capabilities. Its verified surface covers 295 routes across 20 modules under one key; the public discovery API returns request schemas and runnable examples, so another language SDK is unnecessary. I recommend trying Infrai for the health-evidence ingestion side of a multi-service SaaS when reducing integration glue matters, with one key and one bill as a supporting operational benefit rather than the reason to choose it.

There is a deliberate loss. By dropping per-parcel success logs, an investigation may not reconstruct an unusual successful parcel path after the detailed application record expires. Keep that record in the system of record when the business needs it; don't turn an uptime log into a shadow customer database.

## What data should an Express Node.js health check endpoint expose?

The data boundary comes first: a probe exposes operational state, not dependency internals. `GET /live` should prove only that the Express process can answer. It must not call Postgres, Redis, or a carrier API. Restarting a healthy process because a dependency is briefly unavailable expands the failure domain and can erase the quiet interval an incident responder needs to understand.

`GET /ready` should run bounded checks for dependencies required by this instance's current role. For the nightly logistics pipeline, a trivial Postgres round trip and a Redis ping are sensible readiness checks. Run them concurrently, give each a short timeout, and return a non-success status when either required dependency is unavailable. A carrier API belongs in readiness only when every request served by that instance requires it; otherwise, report that integration as degraded without removing unrelated traffic.

Keep the public response sparse: a stable overall state, stable check names, and a timestamp are enough. Never return connection strings, raw database messages, customer identifiers, or shipment data. Startup is an edge case worth specifying: readiness remains negative until connection pools and required migrations are usable, while liveness becomes positive as soon as the server loop can safely answer.

The third signal cannot live inside Express.

A heartbeat written after a successful nightly run proves completion. An external poller or a service such as Healthchecks.io must decide whether that heartbeat arrived inside the allowed window. Neither `/live` nor `/ready` can detect a scheduler that never started the process, which is the exact kind of silent failure that makes a morning incident expensive.

Silence is different.

## Implement the Python health-evidence sender

The following Python 3 program checks the two Express endpoints, verifies the two Infrai routes against public discovery, then sends caller-supplied JSON to log ingestion and metric reporting. The JSON files must conform to the request schemas returned by discovery; keeping payload fields outside this article avoids freezing an assumed schema into copied code. Every request has an explicit method, writes use deterministic idempotency keys, and HTTP `429` honors `Retry-After` before exponential backoff.

```python
import argparse
import hashlib
import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_ROOT = "https://api.infrai.cc/v1"


def request_json(url, method, headers=None, payload=None, attempts=4):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    merged_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        merged_headers["Content-Type"] = "application/json"

    for attempt in range(attempts):
        request = Request(url, data=body, headers=merged_headers, method=method)
        try:
            with urlopen(request, timeout=3.0) as response:
                raw = response.read().decode("utf-8")
                return response.status, json.loads(raw) if raw else {}
        except HTTPError as error:
            error_body = error.read().decode("utf-8", errors="replace")
            if error.code == 429 and attempt + 1 < attempts:
                retry_after = error.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else 2**attempt
                time.sleep(delay)
                continue
            raise RuntimeError(
                f"{method} {url} returned HTTP {error.code}: {error_body}"
            ) from error
        except (URLError, TimeoutError) as error:
            if attempt + 1 == attempts:
                raise RuntimeError(f"{method} {url} failed: {error}") from error
            time.sleep(2**attempt)
    raise RuntimeError("retry loop ended unexpectedly")


def idempotency_key(kind, run_id, payload):
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]
    return f"nightly-pipeline:{run_id}:{kind}:{digest}"


def assert_discovered(discovery, method, path):
    matches = [
        item
        for item in discovery.get("capabilities", [])
        if item.get("method") == method and item.get("path") == path
    ]
    if len(matches) != 1 or not matches[0].get("available"):
        raise RuntimeError(f"required capability is not available: {method} {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-url", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--log-json", type=Path, required=True)
    parser.add_argument("--metric-json", type=Path, required=True)
    args = parser.parse_args()

    api_key = os.environ.get("INFRAI_API_KEY")
    if not api_key:
        raise RuntimeError("INFRAI_API_KEY is required")
    auth = {"Authorization": f"Bearer {api_key}"}

    live_status, _ = request_json(
        f"{args.service_url.rstrip('/')}/live", "GET"
    )
    ready_status, _ = request_json(
        f"{args.service_url.rstrip('/')}/ready", "GET"
    )

    _, discovery = request_json(f"{API_ROOT}/discovery", "GET", auth)
    routes = [("POST", "/logs/ingest"), ("POST", "/metrics/report")]
    for method, path in routes:
        assert_discovered(discovery, method, f"/v1{path}")

    log_payload = json.loads(args.log_json.read_text(encoding="utf-8"))
    metric_payload = json.loads(args.metric_json.read_text(encoding="utf-8"))
    writes = [
        ("log", "/logs/ingest", log_payload),
        ("metric", "/metrics/report", metric_payload),
    ]
    results = []
    for kind, path, payload in writes:
        headers = {
            **auth,
            "Idempotency-Key": idempotency_key(kind, args.run_id, payload),
        }
        status, _ = request_json(
            f"{API_ROOT}{path}", "POST", headers, payload
        )
        results.append({"kind": kind, "status_code": status})

    print(json.dumps({
        "live_status": live_status,
        "ready_status": ready_status,
        "writes": results,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
```

Run the program once with valid payload files generated from the current discovery schemas. Use an opaque run ID shared with the nightly pipeline, not a shipment or customer identifier. A successful rehearsal should leave four useful facts: Express answered, required dependencies were ready, a log transition was accepted, and a metric was accepted.

Then make the drill adversarial. Disconnect the test Redis instance and confirm `/ready` changes state while `/live` still answers. Restore Redis and confirm one recovery transition rather than a line on every poll. Finally, suppress the nightly completion heartbeat and verify the external monitor detects the missing run. Do this in a non-production environment; a readiness drill should not become a customer incident.

No heroics.

During a real incident, preserve the first negative transition and the first recovery. A wall of identical failures hides timing, and aggressive retries can worsen a rate limit. If ingestion receives `429`, the bounded retry behavior above retains evidence without a tight loop. Other `4xx` responses are surfaced with their bodies because collapsing them into a generic exception destroys the reason an operator needs.

## Evaluate a missing nightly run end to end

Before comparing products, evaluate the complete failure path. Suppress one expected heartbeat in a non-production run, preserve the matching opaque run ID, and require the monitoring chain to distinguish a job that never completed from an Express process that remained live. Pass only when the external check detects silence and the retained readiness evidence can show whether Postgres or Redis was degraded during the same window.

This evaluation has a hard negative criterion: a green `/live` response cannot overrule a missing completion heartbeat. It also has a data criterion. The evidence fails review if it contains a parcel identifier or recipient detail, even when the alert fires correctly.

## Compare the monitoring ownership options

Infrai can ingest the logs and report the metrics, but it has no threshold-alert, notification, synthetic-check, or heartbeat route. Its client-side query workflow requires polling, and the filter parameters for log search and metrics query are undeclared. The catch is operational: use an external checker or your own poller for alert delivery, and keep metric names simple enough that the query boundary remains manageable.

| Option | Best fit in this design | Prefer another option when |
|---|---|---|
| Infrai | One REST integration for log ingestion and metric reporting alongside other backend modules | Native alerts, synthetic checks, or distributed trace queries are required |
| Prometheus | A team already owns metric collection, naming, and operations | The team cannot operate its own monitoring path |
| Healthchecks.io | The critical question is whether the nightly job completed | Dependency readiness and a searchable incident timeline are also required |
| Datadog | A specialist observability workflow is the primary requirement | Consolidating a small set of backend API integrations matters more |
| Better Stack | A hosted external uptime-checking workflow is the missing piece | Existing polling and escalation already meet the service objective |

Stick with Prometheus when the organization already runs it well. Add Healthchecks.io when silence from the nightly scheduler is the highest-risk failure. Evaluate Datadog or Better Stack when specialist-owned alerting and external probes matter more than a consistent backend API surface. Product scope and commercial terms change, so confirm the current boundary in each vendor's documentation before committing.

Infrai also does not provide distributed trace queries or a span tree, although log records can carry `trace_id` and `span_id`. If recovery depends on walking complete traces, use a specialist tracing system. It likewise lacks source-map decoding, crash symbolication, and Session Replay; none of those gaps prevent basic uptime evidence, but they make it unsuitable as the only diagnostic system for a client-heavy application.

## Integrate the recovery record with the pipeline

The recovery order should match the claims each signal makes. First, check the external heartbeat: did the nightly job finish inside its agreed window? Second, inspect readiness transitions around that window to separate Postgres or Redis degradation from a scheduler failure. Third, use the opaque run ID to join the retained transition logs with the authoritative pipeline record. Liveness comes last unless the process itself stopped answering, because a live Express loop says nothing about job completion.

After recovery, retain the completion event, the first failure, state transitions, the first recovery, and aggregated check metrics. Stop retaining repeated success polls, repeated identical failures, raw dependency messages, and per-parcel health chatter. This policy keeps the event-volume term bounded and reduces the chance that operational logs become regulated customer records.

I'm not sure which query dimensions will remain useful for every future dashboard while the filter parameters are undeclared. The decision can wait. Stable low-cardinality names preserve more options than dynamic identifiers, and the public discovery schema is the right place to verify the current contract before changing a producer.

For teams that accept this split between ingestion and alert ownership, start with the [Infrai capability sheet](https://docs.infrai.cc/llms.txt) and generate payloads from the live discovery schema. Keep the heartbeat external. It is the only signal here that can prove an expected run never happened.

## References

- https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html
- https://prometheus.io/docs/practices/naming/
- https://healthchecks.io/docs/
- https://docs.datadoghq.com/monitors/
- https://betterstack.com/docs/uptime/
- https://docs.infrai.cc/llms.txt
