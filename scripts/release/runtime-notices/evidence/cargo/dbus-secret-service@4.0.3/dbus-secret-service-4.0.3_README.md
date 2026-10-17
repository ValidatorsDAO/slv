# dbus-secret-service

[![build](https://github.com/brotskydotcom/dbus-secret-service/actions/workflows/ci.yaml/badge.svg)](https://github.com/brotskydotcom/dbus-secret-service/actions)
[![dependencies](https://deps.rs/repo/github/brotskydotcom/dbus-secret-service/status.svg)](https://deps.rs/repo/github/brotskydotcom/dbus-secret-service)
[![crates.io](https://img.shields.io/crates/v/dbus-secret-service.svg?style=flat-square)](https://crates.io/crates/dbus-secret-service)
[![docs.rs](https://docs.rs/dbus-secret-service/badge.svg)](https://docs.rs/dbus-secret-service)

This crate is a knock-off of the [hwchen/secret-service](https://crates.io/crates/secret-service) crate, which is
currently at version 4 and uses [zbus](https://crates.io/crates/zbus) to access the secret service. The basic
collection, item and search APIs in this crate are meant to work the same as the blocking APIs in the zbus-based crate.
If they don't, please file a bug.

Why do a knock-off? So that folks who write synchronous Rust apps that access the secret service (typically through
the [hwchen/keyring](https://crates.io/crates/keyring) crate) are not required to add an async runtime. Because this
knock-off uses lib-dbus, it doesn't require an async runtime.

Why is this crate starting at version 4? Since its API matches a particular version of the dbus-based crate, I figured
it would be clearest if its version number matched that version as well.

## Usage

For code usage examples, see the [documentation](https://docs.rs/dbus-secret-service).

This crate has no default features, and requires no features to run. If you need your secrets to be encrypted on their
way to and from the secret service, then add one of the crypto features:

* `crypto-rust` uses pure Rust crates for encryption.
* `crypto-openssl` uses the openssl libraries for encryption (which must be installed).

See the [documentation](https://docs.rs/dbus-secret-service) for details on how to specify use of an encrypted session.

To _build_ a project that uses this crate, your development machine will need
to have the dbus development headers installed,
and the openssl development headers for the `crypto-openssl` feature.
To _run_ an application that uses this crate,
your machine will need to have `libdbus` installed
(almost all do),
and the openssl libraries for the `crypto-openssl` feature.
If you want to avoid this runtime requirement,
you can specify the `vendored` feature at build time:
this will statically link the needed libraries with your executable.

### Functionality

- SecretService: initialize dbus, create plain/encrypted session.
- Collections: create, delete, search.
- Items: create, delete, search, get/set secret.

## Changelog

v4.0.0: first release, same API as secret-service v4.0.

## License

The copyright to all material in this repository belongs to the collective
of contributors who have checked material into this repository.

All material is this repository is licensed under either of

* Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
* MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

## Contribution

Unless you explicitly state otherwise,
any contribution intentionally submitted for inclusion in the work by you,
as defined in the Apache-2.0 license,
shall be dual licensed as above,
without any additional terms or conditions.
