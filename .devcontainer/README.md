# DevContainer Setup for Treasury26

This devcontainer provides a complete development environment with:
- Rust toolchain (latest + 1.86 for NEAR contracts)
- Node.js LTS
- Docker-in-Docker (for running PostgreSQL)
- PostgreSQL client
- sqlx-cli for database migrations
- Claude Code CLI for AI-assisted development
- GitHub CLI

## Quick Start

### Option 1: VS Code (Recommended)

1. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. Open the repository in VS Code
3. Click "Reopen in Container" when prompted (or use Command Palette: `Dev Containers: Reopen in Container`)
4. Wait for the container to build and initialize

### Option 2: GitHub Codespaces

1. Go to the repository on GitHub
2. Click "Code" → "Codespaces" → "Create codespace on main"
3. Wait for the codespace to initialize

### Option 3: CLI (devcontainer CLI)

```bash
# Install devcontainer CLI
npm install -g @devcontainers/cli

# Build and start the container
devcontainer up --workspace-folder .

# Execute commands in the container
devcontainer exec --workspace-folder . bash
```

## What's Included

### Post-Create Setup (runs once when container is created)

- Installs Rust 1.86 toolchain with wasm32 target
- Installs cargo-near for NEAR contract development
- Installs sqlx-cli for database migrations
- Installs Claude Code CLI
- Creates .env files from examples

### Post-Start Setup (runs each time container starts)

- Starts PostgreSQL test database (port 5433)
- Waits for database to be healthy
- Runs database migrations

## Running Tests

```bash
cd nt-be
cargo test
```

## Using Claude Code Agent

### Interactive Mode

```bash
claude
```

### Automated Mode (for specific tasks)

```bash
# Run the pre-configured agent for issue #159
bash .devcontainer/run-agent.sh

# Or run with a custom prompt
claude --dangerously-skip-permissions -p "Your task description here"
```

## Environment Variables

The container is pre-configured with:

```bash
DATABASE_URL=postgresql://treasury_test:test_password@localhost:5433/treasury_test_db
RUST_LOG=info
```

Your `~/.anthropic` directory is mounted to provide Claude Code authentication.

## Database Access

```bash
# Connect to test database
psql postgresql://treasury_test:test_password@localhost:5433/treasury_test_db

# Or use docker
docker compose -f nt-be/docker-compose.yml exec postgres_test psql -U treasury_test -d treasury_test_db
```

## Troubleshooting

### Database not starting

```bash
# Check Docker status
docker info

# Manually start database
cd nt-be
docker compose up -d postgres_test
docker compose logs postgres_test
```

### Claude Code authentication

Make sure you have authenticated Claude Code on your host machine first:

```bash
# On your host machine (not in container)
claude auth login
```

The `~/.anthropic` directory is mounted into the container.

### Port conflicts

If ports 5432/5433 are in use, stop conflicting services:

```bash
# On host machine
docker ps  # Check for running postgres containers
docker stop <container-id>
```
