# Retired local registration journey

Local registration was removed by slice C3. This historical journey no longer
creates attachments over RPC or MCP. Use `retire-local-register.md` to prove the
operation is absent and old records remain readable. Fixtures for retained
readers are synthetic historical rows/blobs from `legacy-attachment-fixture.ts`;
they are test setup, never a public operation or a copy of the old service.

Keep native owner/path safety controls in preview-policy and native-artifact-binding
tests, immutable Git proofs in in-app-previews-immutable-git-inputs.md and
in-app-previews-git-resolution.md, and historical authorized reads in
in-app-previews-authorized-reads.md. Identity/row gateway primitives remain for
Git and Connections, with their own command/repository tests. No stored data is deleted.
