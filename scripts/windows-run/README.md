# Windows broker replay contract

`windows-console-v1` uses one connection and a monotonically increasing sequence.
The current client sends one request at a time and never reconnects or resends
commands after a timeout. A timeout remains delivery-uncertain.

Pipe/helper loss has an allowed rejection set: `observer-lost` when socket
error/close is observed first, or `delivery-uncertain` when a failed write or
missing receipt is observed first. Killing the broker can produce either order,
including `delivery-uncertain: write EPIPE`. The client preserves the first
failure; subsequent requests return that failure without sending anything.
Callers must accept both categories as failed control, never as successful
termination or permission to retry, reconnect, adopt the target, escalate, or
release its occupancy. A later stop reports the persisted failure without a new
control action. These categories do not establish whether a native action ran.

The broker retains `create-target` and all three control-action receipts for its
entire lifetime. The same sequence and identical request bytes return the original
receipt without another native action. Different bytes for a retained sequence
are rejected. Stage and stop-operation checks also prevent a new sequence from
replaying an action. Lifecycle/nonce validation precedes every cache lookup.

Read-only `observe` and `challenge` replies share a **64-request replay window**.
The create-target response advertises this as the additive
`read_only_replay_window` field. Within that window identical requests return the
original reply and changed requests are rejected. Older read-only sequences
return `preflight-rejected: read-only replay window expired`; the broker does not
query native state again or substitute a newer observation. Rejected requests do
not advance the sequence or evict receipts.

This bounds the cache to 64 read-only entries plus the create/control receipts
(at most four during normal operation). It changes only arbitrarily old
read-only replay: the shipped serial, non-retrying client needs no change, and
control-action retries retain their lifetime guarantee. Clients must not assume
unlimited history for observations/challenges. A missing/old nonce, sequence gap,
changed request or duplicate stage never authorizes a new action.
