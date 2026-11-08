# Secret rotation

Application credential blobs and the optional org AI provider secret
can be re-encrypted from Admin → Operations after
`GRATIS_REKEY_NEW_KEY_FILE` points at a base64 32-byte key file. The
preflight counts those blobs and reports how many the current
`CREDENTIAL_ENCRYPTION_KEY` cannot open. The rekey writes new
ciphertext and, if verification fails, puts the previous ciphertext
back. The previous key file stays with the operator. This process
does not write it into the database.

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
