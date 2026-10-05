# vendor/

Third-party source trees that ship with this repository.

## `ncam/` — NCam softcam

Vendored copy of **https://github.com/fairbird/NCam** (GPL-3.0), the actively
maintained NCam fork, so the panel and the softcam can be built from a single
checkout and the exact revision that was tested stays pinned here.

| | |
| --- | --- |
| Upstream | https://github.com/fairbird/NCam |
| Branch | `master` |
| Commit | `b9882801f73ec309b4101b83d9db1c583b10cdd3` |
| Date | 2026-06-07T00:57:09+03:00 |
| License | GPL-3.0 (see `ncam/COPYING`) |

The sources are **unmodified**: no patches are carried here. NCam remains the
work of its authors and keeps its own licence; vendoring it does not relicense
it, and the CSP code in the rest of the repository is unaffected.

### Build and install it

    sudo bash panel/packaging/install-ubuntu.sh --install-ncam --backend ncam --yes

That compiles this tree, installs `/usr/local/bin/ncam`, writes a minimal
`/etc/ncam/ncam.conf` with the web interface enabled, starts `ncam.service`
and points the panel at it.

By hand:

    cd vendor/ncam
    make -j4 CONF_DIR=/etc/ncam
    sudo install -m 755 Distribution/ncam-*-linux-gnu /usr/local/bin/ncam

Build dependencies on Ubuntu: `build-essential pkg-config libssl-dev
libusb-1.0-0-dev libpcsclite-dev zlib1g-dev`.

Build artefacts (`build/`, `Distribution/ncam-*`) are ignored by the
`.gitignore` that upstream already ships, so a local build never pollutes the
repository.

### Update to a newer upstream

    bash vendor/update-ncam.sh              # latest master
    bash vendor/update-ncam.sh <commit>     # a specific revision

The script re-clones upstream, replaces `vendor/ncam/` and refreshes the commit
and date recorded in the table above. Review the diff before committing.
