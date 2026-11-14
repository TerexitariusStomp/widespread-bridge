"""widespread-mcp — local stdio MCP server for the Widespread protocol.

Holds an Ed25519 agent keypair in ~/.config/widespread/ on THIS machine —
keys are generated and stored client-side, never sent anywhere. Wraps the
same wide_* toolset as the Hermes catalog plugin (vendored _widespread.py).

Run:  uvx widespread-mcp   |   widespread-mcp serve   |   widespread-mcp <tool> <json>
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import _widespread as w

# Redirect key/state storage out of the hermes fallback path.
_DATA = os.path.expanduser(os.environ.get("WIDE_DATA", "~/.config/widespread"))
w._data_path = lambda name: os.path.join(_DATA, name)  # noqa: SLF001


def _tools() -> dict:
    return w._BINDINGS  # noqa: SLF001


def _remote_tools() -> list:
    """Fetch the live remote /mcp tool catalog so any tool this package
    doesn't implement locally still works — proxied straight through.
    Returns [] when the bridge or the mcp client transport is unavailable."""
    try:
        import asyncio
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        async def _list():
            async with streamablehttp_client(w.BRIDGE + "/mcp") as (r, w_, _):
                async with ClientSession(r, w_) as sess:
                    await sess.initialize()
                    return (await sess.list_tools()).tools
        return asyncio.run(_list())
    except Exception:
        return []


def _remote_call(name: str, arguments: dict):
    import asyncio
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async def _call():
        async with streamablehttp_client(w.BRIDGE + "/mcp") as (r, w_, _):
            async with ClientSession(r, w_) as sess:
                await sess.initialize()
                res = await sess.call_tool(name, arguments)
                out = []
                for c in res.content:
                    out.append(getattr(c, "text", json.dumps(c.model_dump())))
                return "\n".join(out) if out else json.dumps(res.model_dump())
    return asyncio.run(_call())


def make_server():
    from mcp.server.fastmcp import FastMCP
    mcp = FastMCP("widespread", instructions=(
        "Earn verified-work bounties on the Widespread protocol. Your "
        "Ed25519 key lives locally in ~/.config/widespread/ — never shared. "
        "Start with wide_bounties (open funded work), then wide_claim, "
        "wide_ship, wide_verdict, wide_payout."))
    for name, fn in _tools().items():
        desc = w._SCHEMAS.get(name, {}).get("description", name)  # noqa: SLF001

        def _mk(fn=fn):
            def call(arguments: str = "{}") -> str:
                try:
                    args = json.loads(arguments) if isinstance(arguments, str) else arguments
                except json.JSONDecodeError:
                    return json.dumps({"error": "arguments must be a JSON object string"})
                return fn(args if isinstance(args, dict) else {})
            return call
        mcp.tool(name=name, description=desc)(_mk())

    # Passthrough: register every remote tool we don't implement locally.
    # The local 16 are bespoke (client-held keys, ledger side-effects);
    # everything else — identity, oracle, requests, sightings — proxies the
    # live catalog so this package never drifts behind the bridge.
    local = set(_tools())
    for t in _remote_tools():
        if t.name in local:
            continue
        def _mkp(tool_name=t.name):
            def call(arguments: str = "{}") -> str:
                try:
                    args = json.loads(arguments) if isinstance(arguments, str) else arguments
                except json.JSONDecodeError:
                    return json.dumps({"error": "arguments must be a JSON object string"})
                return _remote_call(tool_name, args if isinstance(args, dict) else {})
            return call
        mcp.tool(name=t.name, description=t.description or t.name)(_mkp())
    return mcp


def main() -> None:
    p = argparse.ArgumentParser(prog="widespread-mcp",
        description="Local MCP server + CLI for Widespread bounties")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("serve", help="stdio MCP server (default)")
    sub.add_parser("docs", help="print the remote MCP endpoint and exit")
    for name in _tools():
        sp = sub.add_parser(name, help=w._SCHEMAS.get(name, {}).get("description", "")[:80])  # noqa: SLF001
        sp.add_argument("args", nargs="?", default="{}", help="JSON arguments")
    a = p.parse_args()
    if a.cmd == "docs":
        from ._widespread import BRIDGE
        print(f"{BRIDGE}/mcp")
        return
    if a.cmd in (None, "serve"):
        make_server().run(transport="stdio")
        return
    fn = _tools()[a.cmd]
    print(fn(json.loads(a.args)))


if __name__ == "__main__":
    main()
