# Secret rotation

The rekey mutation is not enabled. Rewriting ciphertext in one
process would leave rows that the other API and worker processes
cannot read until every replica is restarted onto the new key, and
a crash during that window is not undone by a SQL rollback. The
preflight still counts application credential blobs and says which
host secrets are outside it. No ciphertext is changed.

That workflow does not rotate:

- the Postgres role password
- the Keycloak client secrets
- the Keycloak admin client secret
- the MinIO root credentials

Those live in the host environment and in Keycloak or the database
role system, not in the application ciphertext. Changing them is a
host procedure: set the new value in the compose env file, restart
the affected service, and confirm sign-in and object upload with a
synthetic account. Do not treat a successful application rekey as
evidence that those host secrets moved.
