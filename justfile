# Default recipe - show available commands
default:
    @just --list

# Run both backend and frontend in parallel
dev:
    #!/usr/bin/env bash
    trap 'kill 0' SIGINT
    just dev-backend & just dev-frontend &
    wait

# Run backend only
dev-backend:
    cd nf-be && cargo watch -x run

# Run frontend only
dev-frontend:
    cd nt-fe && bun run dev -- -p 3001

# Build frontend
build:
    cd nt-fe && bun run build

# Run linter
lint:
    cd nt-fe && bun run lint

# Format code
format:
    cd nt-fe && bun run format

# Install dependencies
install:
    cd nt-fe && bun install

# Clean node_modules
clean:
    rm -rf nt-fe/node_modules

# Clean and reinstall
reinstall: clean install
