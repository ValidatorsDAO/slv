//! A narrow Stage 1 check for rusty_v8's real bindgen invocation.
//!
//! Keep this in lockstep with `rusty_v8/build.rs::build_binding`.  It stops
//! before compiling V8, but does not reduce the test to a synthetic C header:
//! `src/binding.hpp`, the GN-derived defines, the custom libc++ ordering, and
//! bindgen's allow/block lists are the upstream ones.

use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::process::Command;

fn required(name: &str) -> Result<String, Box<dyn Error>> {
  Ok(env::var(name).map_err(|_| format!("{name} must be set"))?)
}

fn main() -> Result<(), Box<dyn Error>> {
  let rusty_v8 = PathBuf::from(required("PROBE_RUSTY_V8")?);
  let gn_out = PathBuf::from(required("PROBE_GN_OUT")?);
  let output = PathBuf::from(required("PROBE_BINDING_OUTPUT")?);
  let python = env::var("PYTHON").unwrap_or_else(|_| "python3".to_string());

  if !rusty_v8.join("src/binding.hpp").is_file() {
    return Err("PROBE_RUSTY_V8 does not contain src/binding.hpp".into());
  }
  if !gn_out.join("project.json").is_file() {
    return Err("PROBE_GN_OUT does not contain GN project.json".into());
  }

  // Match rusty_v8/build.rs: it invokes the upstream helper from the source
  // root, then preserves define ordering while discarding only flags it
  // deliberately replaces below.
  let helper = Command::new(python)
    .current_dir(&rusty_v8)
    .arg("./tools/get_bindgen_args.py")
    .arg("--gn-out")
    .arg(&gn_out)
    .output()?;
  if !helper.status.success() {
    return Err(format!("get_bindgen_args.py exited with {}", helper.status).into());
  }
  let gn_args = String::from_utf8(helper.stdout)?;
  let gn_args = gn_args.split('\0').collect::<Vec<_>>();
  let filtered_args: Vec<&str> = gn_args
    .iter()
    .filter(|arg| {
      !arg.starts_with("-fmodule")
        && !arg.starts_with("-fno-implicit-module")
        && !arg.starts_with("-Xclang")
        && !arg.contains("DUSE_LIBCXX_MODULES")
        && !arg.contains("-nostdinc++")
        && !arg.contains("-isystem")
        && !arg.contains("libc++")
    })
    .copied()
    .collect();

  // This order is intentionally copied from rusty_v8 149.4.0.  Its own
  // build.rs computes this directory from parent(LIBCLANG_PATH)/bin/clang.
  let libclang_path = PathBuf::from(required("LIBCLANG_PATH")?);
  let clang_prefix = libclang_path
    .parent()
    .ok_or("LIBCLANG_PATH has no prefix parent")?;
  let clang = clang_prefix.join("bin/clang");
  let resource = Command::new(&clang).arg("-print-resource-dir").output()?;
  if !resource.status.success() {
    return Err(format!("{} -print-resource-dir failed", clang.display()).into());
  }
  let resource_dir = String::from_utf8(resource.stdout)?;
  let resource_dir = resource_dir.trim();
  if !PathBuf::from(resource_dir).join("include/stddef.h").is_file() {
    return Err(format!("{resource_dir} does not contain include/stddef.h").into());
  }

  env::set_current_dir(&rusty_v8)?;
  let clang_args = vec![
    "-x".to_string(),
    "c++".to_string(),
    "-std=c++20".to_string(),
    "-nostdinc++".to_string(),
    "-Iv8/include".to_string(),
    "-I.".to_string(),
    "-isystembuildtools/third_party/libc++".to_string(),
    "-isystemthird_party/libc++/src/include".to_string(),
    "-isystemthird_party/libc++abi/src/include".to_string(),
    format!("-isystem{resource_dir}/include"),
  ];

  let bindings = bindgen::Builder::default()
    .header("src/binding.hpp")
    .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
    .clang_args(clang_args)
    .clang_args(filtered_args)
    .generate_cstr(true)
    .rustified_enum(".*UseCounterFeature")
    .rustified_enum(".*ModuleImportPhase")
    .rustified_enum(".*Intercepted")
    .bitfield_enum(".*GCType")
    .bitfield_enum(".*GCCallbackFlags")
    .allowlist_item("v8__.*")
    .allowlist_item("cppgc__.*")
    .allowlist_item("RustObj")
    .allowlist_item("memory_span_t")
    .allowlist_item("const_memory_span_t")
    .allowlist_item("ExternalConstOneByteStringResource")
    .blocklist_item("cppgc.*Visitor")
    .blocklist_item("RustObj.*Trace")
    .generate()?;

  bindings.write_to_file(&output)?;
  if std::fs::metadata(&output)?.len() == 0 {
    return Err("bindgen wrote an empty binding file".into());
  }
  Ok(())
}
