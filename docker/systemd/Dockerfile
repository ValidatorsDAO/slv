FROM ubuntu:24.04

ENV container=docker
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  systemd \
  systemd-sysv \
  dbus \
  sudo \
  curl \
  ca-certificates \
  git \
  build-essential \
  pkg-config \
  unzip \
  libssl-dev \
  libudev-dev \
  libclang-dev \
  cmake \
  protobuf-compiler \
  default-mysql-client \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local/deno sh \
  && ln -s /usr/local/deno/bin/deno /usr/local/bin/deno

RUN useradd -m -s /bin/bash slv \
  && echo "slv ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/slv

STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
