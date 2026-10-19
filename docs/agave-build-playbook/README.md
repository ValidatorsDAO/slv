# Agave CLI build playbook

The source for this manual build and publication tool is
[`ansible/agave-build-playbook.yml`](../../ansible/agave-build-playbook.yml).
It checks for the requested Agave artifacts, builds missing artifacts from
[the upstream Agave source](https://github.com/anza-xyz/agave), and publishes them.
The playbook also supports notifications and removes its temporary build files.
Running it can publish artifacts; it is not a build-only command.

The published artifact directory is
`https://storage.slv.dev/agave/<version>/`, containing `agave-validator`,
`solana`, and `solana-keygen`. Select the version explicitly when examining an
artifact or its corresponding upstream source.

These Agave downloads are separate from the verified SLV CLI release. The
SLV release manifest and provenance do not establish the integrity or provenance
of separately downloaded Agave binaries. See
[secure release delivery](../secure-delivery.md) for the verification boundary
of the SLV CLI itself.
