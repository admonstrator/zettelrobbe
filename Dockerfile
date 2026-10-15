ARG BASE_IMAGE=admonstrator/zettelrobbe:latest-base
FROM ${BASE_IMAGE}

ARG PAPERLESS_AI_COMMIT_SHA=unknown

WORKDIR /app

# Copy only necessary application files
COPY --chown=node:node server.js ecosystem.config.js ./
COPY --chown=node:node config ./config/
COPY --chown=node:node models ./models/
COPY --chown=node:node routes ./routes/
COPY --chown=node:node services ./services/
COPY --chown=node:node views ./views/
COPY --chown=node:node public ./public/
COPY --chown=node:node OPENAPI ./OPENAPI/
COPY --chown=node:node schemas.js swagger.js ./
COPY --chown=node:node scripts ./scripts/
COPY docker-entrypoint.sh start-services.sh ./

# An explicit mode rather than +x: the entrypoint re-executes itself after the
# privilege drop, so the unprivileged user has to be able to read it, too. A
# build context that hands the files over without read permission for others
# (e.g. a Samba share with a restrictive create mask) would otherwise produce
# 0711 and a restart loop with "cannot open ./docker-entrypoint.sh".
RUN chmod 755 docker-entrypoint.sh start-services.sh

# Configure persistent data volume.
# Docker seeds a fresh named volume from the image including ownership and mode,
# so the data directory is prepared here rather than left to the entrypoint:
# root:node 775 is writable for root (before the privilege drop) and for the
# node user (after it), which keeps the default deployment working even when the
# container has no CAP_CHOWN to repair ownership at runtime.
RUN mkdir -p /app/data/logs && \
    chown -R root:node /app/data && \
    chmod -R 775 /app/data
VOLUME ["/app/data"]

# Runtime starts as root to initialize mounted volumes, then drops to node via entrypoint
USER root

# Configure application port
EXPOSE ${PAPERLESS_AI_PORT:-3000}

# Add health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PAPERLESS_AI_PORT:-3000}/health || exit 1

# Set production environment
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    PAPERLESS_AI_COMMIT_SHA=${PAPERLESS_AI_COMMIT_SHA}

LABEL org.opencontainers.image.revision=${PAPERLESS_AI_COMMIT_SHA}

ENTRYPOINT ["./docker-entrypoint.sh"]

# Start Node.js service using PM2
CMD ["pm2-runtime", "ecosystem.config.js"]
