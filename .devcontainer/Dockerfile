FROM mcr.microsoft.com/devcontainers/base:debian-12

# Install tmux for integration tests of notifier module
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates curl unzip git \
 && rm -rf /var/lib/apt/lists/*

# Install Bun directly (feature unavailable in some networks)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.19" \
 && export BUN_INSTALL="$HOME/.bun" \
 && echo 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc" \
 && echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"

# Bun is installed via the devcontainer feature (see devcontainer.json).
# Verify installation is delegated to postCreate.sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates curl unzip git \
 && rm -rf /var/lib/apt/lists/*

# Bun is installed via the devcontainer feature (see devcontainer.json).
# Verify installation is delegated to postCreate.sh.

USER vscode
WORKDIR /workspaces
