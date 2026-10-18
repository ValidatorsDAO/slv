Rustc target triple
===================

[<img alt="github" src="https://img.shields.io/badge/github-dtolnay/target--triple-8da0cb?style=for-the-badge&labelColor=555555&logo=github" height="20">](https://github.com/dtolnay/target-triple)
[<img alt="crates.io" src="https://img.shields.io/crates/v/target-triple.svg?style=for-the-badge&color=fc8d62&logo=rust" height="20">](https://crates.io/crates/target-triple)
[<img alt="docs.rs" src="https://img.shields.io/badge/docs.rs-target--triple-66c2a5?style=for-the-badge&labelColor=555555&logo=docs.rs" height="20">](https://docs.rs/target-triple)
[<img alt="build status" src="https://img.shields.io/github/actions/workflow/status/dtolnay/target-triple/ci.yml?branch=master&style=for-the-badge" height="20">](https://github.com/dtolnay/target-triple/actions?query=branch%3Amaster)

Access the $TARGET and $HOST [rustc target triples][platform support] that Cargo
supplies to build scripts.

[platform support]: https://doc.rust-lang.org/rustc/platform-support.html

## Example

```rust
fn main() {
    // As a const &str:
    assert_eq!(target_triple::TARGET, "x86_64-unknown-linux-gnu");

    // As a string literal:
    assert_eq!(
        concat!("target/", target_triple::target!()),
        "target/x86_64-unknown-linux-gnu",
    );
}
```

<br>

#### License

<sup>
Licensed under either of <a href="LICENSE-APACHE">Apache License, Version
2.0</a> or <a href="LICENSE-MIT">MIT license</a> at your option.
</sup>

<br>

<sub>
Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this crate by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.
</sub>
