# Bridge ingress

The bridge binds to exactly one GitHub owner, so it runs as three services —
`flama-bridge-maxbec`, `flama-bridge-navigaite`, `flama-bridge-edilio` — each
with its own webhook secret, its own Paperclip trigger credential, and its own
port (3010, 3011, 3012) on `ai-vm`.

## Bind address

`FLAMA_BRIDGE_HOST` is validated, not passed through to `listen`. The accepted
values are loopback (`127.0.0.1`, `::1`), the two wildcards (`0.0.0.0`, `::`),
and a private IPv4 literal in `10/8`, `172.16/12`, or `192.168/16`. A hostname
is refused because what it resolves to is not knowable in the process, and an
address with a leading zero is refused because resolvers disagree on whether it
is octal. A routable address is refused outright: the bridge is reached through
a tunnel, so binding it to one would be a mistake, not a configuration choice.

The services bind `192.168.1.204`. That is narrower than `0.0.0.0` — the
wildcard would also publish the bridge on every other interface the host gains
later — and it is what the tunnel connector needs, because the connector does
not run on the same host.

## Public ingress

The connector is the existing `cloudflared` container on `unraid`, running a
remote-managed tunnel. Its ingress rules resolve three public hostnames to the
three LAN origins. Nothing on the bridge listens publicly; the only public
surface is the tunnel, and a Cloudflare WAF rule restricts each hostname to
GitHub's published hook ranges.

| Hostname | Origin | Owner |
| --- | --- | --- |
| `flama-bridge-maxbec.bc-family.de` | `http://192.168.1.204:3010` | `maxbec` |
| `flama-bridge-navigaite.bc-family.de` | `http://192.168.1.204:3011` | `navigaite` |
| `flama-bridge-edilio.bc-family.de` | `http://192.168.1.204:3012` | `edilio-app` |

Origin traffic crosses the LAN unencrypted between `unraid` and `ai-vm`. That
is accepted: the payload is already public GitHub metadata, and the bridge
authenticates every webhook by HMAC before it parses the body, so a LAN
attacker who cannot read the secret from Infisical cannot forge an event.

## Verifying

```bash
systemctl --user is-active flama-bridge-maxbec flama-bridge-navigaite flama-bridge-edilio
for port in 3010 3011 3012; do curl -sS -o /dev/null -w "$port %{http_code}\n" "http://192.168.1.204:$port/health"; done
```

`/health` reports the process; `/ready` additionally reports the database. A
webhook that arrives without a valid signature is rejected before parsing and
is not queued, so a 401 in the logs is the guard working, not an outage.

## What a signed delivery actually does

Replaying a signed `push` for a bound repository over the LAN, before any
tunnel exists, gives:

| Request | Result |
| --- | --- |
| valid signature, fresh delivery id | `202 {"accepted":true,"duplicate":false}` |
| same delivery id again | `202 {"accepted":true,"duplicate":true}` |
| tampered signature | `401 invalid_signature` |
| no signature | `401 invalid_signature` |
| sent to another owner's bridge | `401` — it fails on that bridge's own secret before scope is ever consulted |
| unsupported event (`star`) | `202 {"accepted":false,"ignored":true}` |

The accepted delivery is minimized, queued, and marked `completed` in
`webhook_inbox`; the worker moves it to `transition_outbox`, attempts it five
times, and dead-letters it with `authorization_missing`.

That last step is the important one. **Ingress alone does not make events
flow.** The bridge signs a Paperclip routine-trigger request only for a
lifecycle edge the company controller has already authorized, and the
controllers are paused and zero-budget, so no authorization exists yet. The
order is: ingress, then scoped authorization writes, then routine activation.
A dead letter reading `authorization_missing` is the design holding, not a
fault.

## Known gap

The bridge logs nothing on a normal delivery — not an acceptance, not a
dead-letter. The five-attempt failure above is visible only by querying
`dead_letter` directly. Anything relying on the bridge should watch that table
rather than the journal until this is addressed.
