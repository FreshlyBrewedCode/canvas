# canvas relay (ADR 0008): the relay alone, bundled into one file.
#
#   docker build -t canvas-relay .
#   docker run -p 4419:4419 -e CANVAS_RELAY_KEYS=team:<secret> canvas-relay
#
# Settings are environment variables (site/content/docs/relay.md). It speaks
# plain ws:// on 4419: put a TLS proxy in front, or mount a certificate and set
# CANVAS_RELAY_TLS_CERT and CANVAS_RELAY_TLS_KEY.

FROM oven/bun:1 AS build
WORKDIR /src
COPY src/shared src/shared
COPY src/server/relay*.ts src/server/
RUN bun build src/server/relay-main.ts --target=bun --minify --outfile /out/relay.js

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /out/relay.js .
USER bun
ENV CANVAS_RELAY_PORT=4419
EXPOSE 4419
HEALTHCHECK --interval=30s --timeout=3s \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.CANVAS_RELAY_PORT}/health`); process.exit(r.ok ? 0 : 1)"]
ENTRYPOINT ["bun", "relay.js"]
