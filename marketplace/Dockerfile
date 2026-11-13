# Docker MCP Catalog package — stdio server, client-held key volume
FROM python:3.12-slim
RUN pip install --no-cache-dir widespread-mcp
VOLUME /root/.config/widespread
ENTRYPOINT ["widespread-mcp", "serve"]
