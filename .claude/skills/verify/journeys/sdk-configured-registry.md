## First start uses the configured package manager

Build and compile the daemon, then run `sdk-configured-registry.sh` with the
compiled binary, an installed matching platform SDK binary, and a fresh absolute
run directory. The fixture supplies a fake npm and a local tarball; curl refuses
all network access. Pass: the daemon reports the SDK ready and fake npm receives
four arguments. The run directory retains the daemon log and fixture arguments.

The pnpm-only registry and HTML error cases are covered by the package download
fixtures; this journey proves the compiled daemon's npm path.

Pass `npm-failure` as the fifth argument to make npm fail. The daemon must
report its exit code and network classification without logging stderr or invoking pnpm or curl.

Pass `pnpm-failure` as the fifth argument to serve the local tarball after a
fake pnpm fails. The daemon must report the SDK ready through fake curl.
