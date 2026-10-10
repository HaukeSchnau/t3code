# SQLite provider event reliability

Concurrent access to the WAL database must not fail a provider turn during a read-to-write
transaction upgrade. Writable connections begin transactions with `BEGIN IMMEDIATE`, so
the configured busy timeout applies before the transaction reads. Read-only connections
retain deferred transactions and can read while a writer owns the database.

If provider event ingestion still fails, stop the current provider turn before recording
the failed run. Check ownership first so a stale subscription cannot stop a newer turn.
Normal stream cancellation during startup must not interrupt another turn.

These requirements follow the October 10 incident where SQLite rejected event writes,
Claude continued working without visible output, and retries found its old turn active.
Remove this patch when upstream provides both transaction and provider cleanup guarantees.
