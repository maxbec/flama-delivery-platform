# Bridge ingress

The bridge binds to exactly one GitHub owner, so it runs as one service per
owner — three in this estate — each with its own webhook secret, its own
Paperclip trigger credential, and its own port. Concrete hosts, addresses, and
public hostnames are deployment facts and are recorded privately, not here.

## Bind address

`FLAMA_BRIDGE_HOST` is validated, not passed through to `listen`. The accepted
values are loopback (`127.0.0.1`, `::1`), the two wildcards (`0.0.0.0`, `::`),
and a private IPv4 literal in `10/8`, `172.16/12`, or `192.168/16`. A hostname
is refused because what it resolves to is not knowable in the process, and an
address with a leading zero is refused because resolvers disagree on whether it
is octal. A routable address is refused outright: the bridge is reached through
a tunnel, so binding it to one would be a mistake, not a configuration choice.

Where the tunnel connector runs on a different host from the bridge, bind the
private interface address rather than a wildcard. The wildcard would also
publish the bridge on every other interface the host gains later.

## Public ingress

A tunnel connector terminates the public hostname and forwards to the private
origin; nothing on the bridge listens publicly. Each hostname is additionally
restricted at the edge to GitHub's published hook ranges, which change over
time and should be read from `GET /meta` rather than copied.

Origin traffic crosses the private network unencrypted between the connector
and the bridge. That is accepted: the payload is public GitHub metadata, and
the bridge authenticates every webhook by HMAC before it parses the body, so an
attacker on that network who cannot read the secret cannot forge an event.

## Verifying

```bash
systemctl --user is-active flama-bridge-<owner>
curl -sS -o /dev/null -w '%{http_code}\n' "http://<bind-address>:<port>/health"
```

`/health` reports the process; `/ready` additionally reports the database. A
webhook that arrives without a valid signature is rejected before parsing and
is not queued, so a 401 is the guard working, not an outage.

## What a signed delivery actually does

Replaying a signed `push` for a bound repository over the private network,
before any tunnel exists, gives:

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
