# Docker services for local development and testing

Prior to this docker setup, the method of developing and testing the posthog `plugin-server` was to have the https://github.com/Posthog/posthog repository cloned to `../posthog/`, and reuse the databases and python scripting environment there. This is quite brittle. People are configuring the posthog for local dev in various ways, plus this repository in various ways, introducing some number of combinations for how the two play together.

This dir holds schemas for postgres and clickhouse, snapshotted from the `posthog` repo, thereby reducing the dev dependency on `posthog` to just these schemas, no need to make sure that you've got a python virturalenv setup in a specific location for instance.

We also copy over the `ee/idl/` directory from `posthog` which contains protobufs required by clickhouse.

These schemas and idl shouldn't be modified by hand, but rather use the `bin/dump-pg-schema` and `bin/dump-clickhouse-schema` commands in the `posthog` repo.
