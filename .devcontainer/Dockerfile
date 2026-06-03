FROM mcr.microsoft.com/devcontainers/base:debian-12

# Install tmux for integration tests of notifier module
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates curl unzip git \
 && rm -rf /var/lib/apt/lists/*

USER vscode

ENV BUN_INSTALL=/home/vscode/.bun
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Install Bun directly (feature unavailable in some networks)
RUN curl -fsSL https://bun.sh/install > /tmp/install.sh \
 && bash /tmp/install.sh "bun-v1.2.19" \
 && rm /tmp/install.sh

WORKDIR /workspaces
