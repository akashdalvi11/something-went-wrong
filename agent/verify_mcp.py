"""Phase 0 verification: connect to the Dynatrace-hosted remote MCP server,
list its tools, and execute one DQL query.

Usage:
    agent/.venv/bin/python agent/verify_mcp.py
    agent/.venv/bin/python agent/verify_mcp.py "fetch logs | limit 3"

Reads DT_ENVIRONMENT_NAME and DT_PLATFORM_TOKEN from .env / environment.
"""

import asyncio
import json
import os
import sys

from dotenv import load_dotenv
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

DT_ENV = os.environ.get("DT_ENVIRONMENT_NAME")
DT_TOKEN = os.environ.get("DT_PLATFORM_TOKEN")
DQL = sys.argv[1] if len(sys.argv) > 1 else "fetch spans | limit 5"

MCP_URL = (
    f"https://{DT_ENV}.apps.dynatrace.com"
    "/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp"
)


def find_dql_tool(tools):
    for tool in tools:
        if "dql" in tool.name.lower() and "execute" in tool.name.lower():
            return tool
    for tool in tools:
        if "dql" in tool.name.lower():
            return tool
    return None


def string_arg_name(tool):
    """Pick the schema property that takes the DQL statement."""
    props = (tool.inputSchema or {}).get("properties", {})
    for candidate in ("dqlStatement", "dql", "statement", "query"):
        if candidate in props:
            return candidate
    required = (tool.inputSchema or {}).get("required", [])
    for name in required:
        if props.get(name, {}).get("type") == "string":
            return name
    return None


async def main():
    if not DT_ENV or not DT_TOKEN:
        sys.exit("Set DT_ENVIRONMENT_NAME and DT_PLATFORM_TOKEN in .env first.")

    print(f"Connecting to {MCP_URL} ...")
    headers = {"Authorization": f"Bearer {DT_TOKEN}"}

    async with streamablehttp_client(MCP_URL, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = (await session.list_tools()).tools
            print(f"\n✅ Connected. {len(tools)} tools available:")
            for tool in tools:
                print(f"  - {tool.name}")

            dql_tool = find_dql_tool(tools)
            if dql_tool is None:
                sys.exit("\n❌ No DQL execution tool found — check token scopes.")

            arg = string_arg_name(dql_tool)
            if arg is None:
                print(f"\nInput schema of {dql_tool.name}:")
                print(json.dumps(dql_tool.inputSchema, indent=2))
                sys.exit("❌ Could not determine the DQL argument name (schema above).")

            print(f"\nExecuting via {dql_tool.name}({arg}=...): {DQL}")
            result = await session.call_tool(dql_tool.name, {arg: DQL})
            for block in result.content:
                if hasattr(block, "text"):
                    print(block.text[:3000])
            print("\n✅ DQL executed. Phase 0 verification complete.")


if __name__ == "__main__":
    asyncio.run(main())
