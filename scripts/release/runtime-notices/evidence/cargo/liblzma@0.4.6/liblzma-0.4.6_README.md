# liblzma

[![CI](https://github.com/Portable-Network-Archive/liblzma-rs/actions/workflows/main.yml/badge.svg)](https://github.com/Portable-Network-Archive/liblzma-rs/actions/workflows/main.yml)
[![Crates.io][crates-badge]][crates-url]

[crates-badge]: https://img.shields.io/crates/v/liblzma.svg
[crates-url]: https://crates.io/crates/liblzma

[Documentation](https://docs.rs/liblzma)

Bindings to the liblzma implementation in Rust, also provides types to
read/write xz streams.

**This crate is forked from [xz2](https://crates.io/crates/xz2) and `liblzma = "0.1.x"` is fully compatible with `xz2 = "0.1.7"`,**
so you can migrate simply.

## Migrate from xz2

```diff
# Cargo.toml
[dependencies]
-xz2 = "0.1.7"
+liblzma = "0.1.7"
```

```diff
// *.rs
-use xz2;
+use liblzma;
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
- Dropped `tokio` support (If you need async I/O, use [`async-compression`](https://github.com/Nullus157/async-compression) crate with `lzma` feature flag)

## License

This project is licensed under either of

 * Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or
   http://www.apache.org/licenses/LICENSE-2.0)
 * MIT license ([LICENSE-MIT](LICENSE-MIT) or
   http://opensource.org/licenses/MIT)

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in liblzma by you, as defined in the Apache-2.0 license, shall be
dual licensed as above, without any additional terms or conditions.
