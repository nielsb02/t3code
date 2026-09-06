# T3 Code — Micro Manager fork

This fork adds exact desktop session opening for
[Micro Manager](https://github.com/nielsb02/t3-micro-manager). A Creator Micro key
can select the session in the existing T3 desktop window.

[Desktop downloads](https://github.com/nielsb02/t3code/releases/latest) ·
[Update automation](https://github.com/nielsb02/t3code/actions/workflows/micro-desktop.yml) ·
[Fork maintenance](../docs/operations/micro-fork.md) ·
[Upstream T3 Code](https://github.com/pingdotgg/t3code)

The fork checks published upstream releases daily, preserves its desktop patch,
and tests and builds updates before publishing. Conflicts or failures stop an
update and keep the previous desktop download available. Source syncing and
build publication are automatic; unsigned macOS app installation is a separate
step. No agent runs as part of this automation.

The current downloads target Apple Silicon Macs and are not notarized. The app
keeps T3's normal data location. Close an existing T3 process before changing
installations, then choose the fork's app in Micro Manager's desktop settings.

For the broader project, see the [upstream README](../README.md).
