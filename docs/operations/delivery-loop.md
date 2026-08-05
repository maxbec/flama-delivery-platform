# The delivery loop, end to end

How a change reaches Paperclip, what each hop actually proves, and where the
loop currently stops. Written after every in-scope repository was migrated and
the loop was exercised with real GitHub traffic for the first time.

Concrete hostnames, addresses, ports, and owner names are deployment facts and
are recorded privately, not here. This describes the mechanism.

## The path

```
GitHub ─▶ edge ─▶ tunnel ─▶ reverse proxy ─▶ bridge ─▶ inbox ─▶ outbox ─▶ Paperclip routine
```

Each hop below is verified by something observable, rather than by the previous
hop reporting success.

## Ingress

One bridge per GitHub owner, because a bridge binds to exactly one owner by
design and refuses a payload for any other with `owner_scope_denied`. One
public hostname per owner. Bind addresses and ports are covered in
[bridge ingress](./bridge-ingress.md).

Where a reverse proxy already terminates the domains the bridges live under,
route the bridge hostnames **through that proxy** rather than adding
tunnel-level routes beside it. Tunnel ingress rules match top to bottom, first
match wins, so a specific hostname route placed after a wildcard that sends the
whole domain to the proxy is never reached — the request arrives at the proxy,
which has no matching router, and returns its own 404. Routing at the proxy also
allows rate limiting keyed on the forwarded client IP, which a tunnel route
cannot express.

Do not place an identity-based access product in front of a webhook endpoint.
Those expect a browser and a login; a webhook sender issues an unauthenticated
POST and cannot complete an authentication flow, so every delivery is redirected
to a login page and none arrives. The bridge authenticates callers by HMAC,
which is the control designed for machine senders.

## What a 2xx actually proves

The bridge answers `202` both for an accepted delivery and for one its event
filter discards. The setup ping a provider sends when a webhook is saved falls
to the filter's default branch — *before* the enqueue path, owner scoping and
Paperclip forwarding — so a `202` on a ping proves routing and signature
verification and nothing beyond.

Treating it as evidence that the loop works is a claim about externally
verifiable state that the response does not support. The sound check is a real
event appearing in the inbox.

## App configuration has three parts, and two of them look complete alone

1. **Webhook** — URL, secret, JSON content type, and *Active*.
2. **Events** — exactly the set the repository contract names.
3. **Installation approval** — some events require a permission the App may not
   already hold. Adding a permission puts the change in a pending state *per
   installation*, and **event subscriptions do not take effect until it is
   approved**, even though the App settings page shows them saved.

The App endpoint reports what the App requests; the installations endpoint
reports what each installation actually has. When those disagree, an approval is
outstanding and no events are delivered. Compare the two rather than trusting
either alone.

## Company scoping in the outbox

Every bridge shares one database and one transition outbox. Claiming must be
scoped by company. Without that filter each worker takes whichever row is next,
including another owner's, and a bridge holding a foreign transition fails the
publisher's scope check. That code is permanent rather than retryable, so the
event is dead-lettered immediately and never offered to the bridge that could
have published it.

The first real traffic measured the cost: of nineteen transitions from a single
pull request, seventeen were destroyed this way, and the survivors were only
those whose owning bridge won the race. The dead-letter reason named
authorization rather than the claim, so the fault reads as a Paperclip problem
until the claim query itself is examined.

## Authorization is the point, not an obstacle

The bridge fires a routine only where a matching external transition
authorization exists. The lookup keys on the exact delivery id **and** the
minimized event digest, so an authorization cannot be written ahead of time —
the provider generates the delivery id. It is written after the event lands,
inside the outbox retry window, by the controller observing the inbox.

That ordering is the design: an agent declares the transition it expects, the
provider independently reports the fact, and state advances only where both
agree. An agent cannot mark its own work done.

## Where the loop stops today

Events reach the outbox and retry until they expire, because nothing writes the
authorization row. The delivery controller is a Paperclip agent rather than a
process — marking it active does not schedule it.

Until an agent runs, a preflight check must be published out of band for a pull
request to satisfy the policy gate, and dead letters accumulate as real events
arrive unauthorized. Both are expected, and neither indicates a fault in the
path above.
