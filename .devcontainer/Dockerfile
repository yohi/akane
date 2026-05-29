FROM mcr.microsoft.com/devcontainers/base:debian-12

# Install tmux for integration tests of notifier module
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates curl unzip git \
 && rm -rf /var/lib/apt/lists/*

# Bun is installed via the devcontainer feature (see devcontainer.json).
# Verify installation is delegated to postCreate.sh.

USER vscode
WORKDIR /workspaces
