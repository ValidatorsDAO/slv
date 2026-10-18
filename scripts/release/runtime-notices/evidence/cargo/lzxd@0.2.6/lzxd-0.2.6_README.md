# lzxd

A Rust implementation of [Microsoft's lzxd encoding][1], based in the description and code of
the document itself. This crate currently only implements decompression.

```rust
use lzxd::{Lzxd, WindowSize};

let mut lzxd = Lzxd::new(WindowSize::KB64);

while let Some(chunk) = get_compressed_chunk() {
    let decompressed = lzxd.decompress_next(&chunk);
    write_data(decompressed.unwrap());
}
```

The project's motivation was to be able to read XNB files produced by XNA Game Studio, some of
which are compressed under LZXD compression.

Huge thanks to [LeonBlade for their xnbcli][2] project which helped greatly to debug this
implementation, and special mention to [dorkbox's CabParser][3] for further helping validate
that this implementation is able to decompress real-world data correctly.

## License

This library is licensed under either of

* Apache License, Version 2.0 ([LICENSE-APACHE] or
  http://www.apache.org/licenses/LICENSE-2.0)

* MIT license ([LICENSE-MIT] or http://opensource.org/licenses/MIT)

at your option.

[1]: https://docs.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-patch/cc78752a-b4af-4eee-88cb-01f4d8a4c2bf
[2]: https://github.com/LeonBlade/xnbcli
[3]: https://github.com/dorkbox/CabParser/
[LICENSE-APACHE]: LICENSE-APACHE
[LICENSE-MIT]: LICENSE-MIT
