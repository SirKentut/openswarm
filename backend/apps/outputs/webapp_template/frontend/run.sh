#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
RUN_FRONTEND_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    # echo "In macOS server sed START"
    # echo "SERVER_ABSPATH: $SERVER_ABSPATH"
    sed -i '' 's/\r//g' "$RUN_FRONTEND_ABSPATH"
    # echo "In macOS server sed END"
else
    # echo "NOT in macOS server START"
    # echo "SERVER_ABSPATH: $SERVER_ABSPATH"
    sed -i 's/\r//g' "$RUN_FRONTEND_ABSPATH"
    # echo "NOT in macOS server START"
fi
chmod +x "$RUN_FRONTEND_ABSPATH"

FRONTEND_DIR_ABSPATH="$(dirname "$RUN_FRONTEND_ABSPATH")"

cd "$FRONTEND_DIR_ABSPATH"

# Fast path: the seeder usually symlinks node_modules to a shared warm
# cache (~/.openswarm/cache/webapp_template_node_modules/<hash>), so the
# dependency install has already been done once and we can skip straight
# to vite. Only run npm install when node_modules is genuinely missing
# or empty — e.g. a workspace seeded before the warm-cache existed, or
# the user's cache was cleared.
if [ -d node_modules ] && [ -n "$(ls -A node_modules 2>/dev/null)" ]; then
    echo "Dependencies already present — skipping install."
else
    echo "Installing dependencies..."
    npm install --prefer-offline --no-audit --no-fund
fi

echo "Building with development mode..."
npm run dev

# exit back to the dir that we were in before
cd -
