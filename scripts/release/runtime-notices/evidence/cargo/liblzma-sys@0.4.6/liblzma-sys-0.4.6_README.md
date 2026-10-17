# liblzma-sys

[![CI](https://github.com/Portable-Network-Archive/liblzma-rs/actions/workflows/main.yml/badge.svg)](https://github.com/Portable-Network-Archive/liblzma-rs/actions/workflows/main.yml)
[![Crates.io][crates-badge]][crates-url]

[crates-badge]: https://img.shields.io/crates/v/liblzma-sys.svg
[crates-url]: https://crates.io/crates/liblzma-sys

[Documentation](https://docs.rs/liblzma-sys)

Raw bindings to liblzma which contains an implementation of LZMA and xz stream
encoding/decoding.

High level Rust bindings are available in the [liblzma](https://crates.io/crates/liblzma) crate.

**This crate is forked from [lzma-sys](https://crates.io/crates/lzma-sys) and `liblzma-sys = "0.1.x"` is fully compatible with `lzma-sys = "0.1.20"`,**
so you can migrate simply.

## Migrate from lzma-sys

```diff
# Cargo.toml
[dependencies]
-lzma-sys = "0.1.20"
+liblzma-sys = "0.1.20"
```

```diff
// *.rs
-use lzma_sys;
+use liblzma_sys;
```

## Version 0.2.x breaking changes

- XZ upgraded to 5.4
- Multithreading is disabled by default.
  This feature is available by enabling the `parallel` feature
- Support for compiling to WebAssembly

## Version 0.3.x breaking changes

- XZ upgraded to 5.6

## Version 0.4.x breaking changes

- XZ upgraded to 5.8

## License

This project is licensed under either of

* Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or
  http://www.apache.org/licenses/LICENSE-2.0)
* MIT license ([LICENSE-MIT](LICENSE-MIT) or
  http://opensource.org/licenses/MIT)

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in liblzma-sys by you, as defined in the Apache-2.0 license, shall be
dual licensed as above, without any additional terms or conditions.
