# SOCKS5 Proxy Routing Design

## Goal

Let an administrator maintain authenticated or unauthenticated SOCKS5 proxies and route every Minecraft bot either directly, through an evenly distributed proxy pool in fixed list order, or through an explicit per-bot assignment.

## Configuration and secrecy

Proxy credentials live in `config/proxies.json`, which is ignored by Git. The file contains a mode (`off`, `balanced`, or `manual`), proxy records, and manual bot assignments. The dashboard state returns proxy identity, address, username, enabled state, and whether a password exists; it never returns the password itself.

Saving a proxy record without a password retains an existing stored password with the same id. An explicit clear-password flag removes it. Proxy ids are stable opaque strings so editing a display name does not break assignments.

## Assignment rules

- `off`: every bot connects directly.
- `balanced`: bot at zero-based index `i` uses enabled proxy at index `i % k`, where `k` is the number of enabled proxies. Bot roster order and proxy pool order are preserved. The number of bots assigned to any two enabled proxies differs by at most one. Reconnects and restarts keep the same mapping while the lists retain the same order; changes to either list rebuild the plan.
- `manual`: the administrator assigns a proxy id to each bot. A bot without a valid enabled assignment is blocked before opening a TCP connection.

The route lookup happens at connection time. Saving proxy settings changes the next connection; an optional reconnect action closes current sessions and reconnects the fleet with the new plan.

## Connection path

Both Mineflayer and the raw `minecraft-protocol` transport use the same SOCKS5 connector. It asks the proxy to connect to the configured Minecraft host and port, hands the resulting socket to the protocol client, and emits the normal client connection event. Direct mode retains the existing TCP path.

Proxy handshake failures enter the existing connection error path and identify the proxy by display label without including its password. A bot's dashboard card shows its current route or why manual routing blocks it.

## Admin interface

The dashboard gains a Proxies tab with:

- routing mode selection;
- proxy rows for name, host, port, optional username/password, enabled state, and removal;
- a generated assignment table for all configured bots;
- save and save-and-reconnect actions;
- balanced assignment previews and manual selectors.

The UI keeps unsaved proxy edits while server-sent state updates arrive.

## Validation

Proxy host and id must be non-empty, ports must be integers from 1 through 65535, ids must be unique, and assignments must reference enabled known proxies. The pool may be empty only in `off` mode. Invalid settings are rejected without replacing the last valid in-memory or on-disk configuration.
