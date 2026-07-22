#!/bin/bash
# start-services.sh - Script to start the Node.js service

set -euo pipefail

# Keep Node.js service on configured verbosity level.
export LOG_LEVEL="${LOG_LEVEL:-info}"

# Start the Node.js application
echo "Starting Node.js Zettelrobbe service..."
pm2-runtime ecosystem.config.js
