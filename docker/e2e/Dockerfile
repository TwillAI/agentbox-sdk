FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
ENV XDG_CONFIG_HOME=/root/.config
ENV CODEX_HOME=/root/.codex

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex @anthropic-ai/claude-code

RUN curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path \
  && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
  && opencode --version

WORKDIR /workspace

CMD ["sleep", "infinity"]
