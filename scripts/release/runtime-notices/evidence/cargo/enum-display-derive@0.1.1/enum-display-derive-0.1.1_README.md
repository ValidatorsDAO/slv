# Derive Display trait for enums

[![Build Status](https://travis-ci.org/ihrwein/enum-display-derive.svg?branch=master)](https://travis-ci.org/ihrwein/enum-display-derive)
[![crates.io](http://meritbadge.herokuapp.com/enum-display-derive)](https://crates.io/crates/enum-display-derive)

[Documentation](https://docs.rs/enum-display-derive)

This crate can derive a `Display` implementation for very simple enums,
like the following one:

```rust
#[macro_use]
extern crate enum_display_derive;

use std::fmt::Display;

#[derive(Display)]
enum FizzBuzz {
   Fizz,
   Buzz,
   FizzBuzz,
   Number(u64),
}

fn fb(i: u64) -> FizzBuzz {
   match (i % 3, i % 5) {
       (0, 0) => FizzBuzz::FizzBuzz,
       (0, _) => FizzBuzz::Fizz,
       (_, 0) => FizzBuzz::Buzz,
       (_, _) => FizzBuzz::Number(i),
   }
}

fn main() {
   for i in 0..100 {
       println!("{}", fb(i));
   }
}
```

You should see the following output:

```
FizzBuzz
1
2
Fizz
4
Buzz
Fizz
7
...
```

## License

Licensed under either of
 * Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
 * MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)
at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any
additional terms or conditions.`
