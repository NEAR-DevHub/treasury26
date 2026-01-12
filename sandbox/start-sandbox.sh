#!/bin/bash
set -e

# Detect architecture
ARCH=$(uname -m)
VERSION="2.9.0"

case $ARCH in
    aarch64|arm64)
        SANDBOX_URL="https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-aarch64/${VERSION}/near-sandbox.tar.gz"
        ;;
    x86_64|amd64)
        SANDBOX_URL="https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/${VERSION}/near-sandbox.tar.gz"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Download and extract near-sandbox if not present
if [ ! -f /usr/local/bin/near-sandbox ]; then
    echo "Downloading near-sandbox for $ARCH..."
    TEMP_DIR=$(mktemp -d)
    curl -L "$SANDBOX_URL" | tar -xz -C "$TEMP_DIR"
    # Handle nested directory structure (e.g., Linux-x86_64/near-sandbox)
    find "$TEMP_DIR" -name "near-sandbox" -type f -exec mv {} /usr/local/bin/near-sandbox \;
    chmod +x /usr/local/bin/near-sandbox
    rm -rf "$TEMP_DIR"
    echo "near-sandbox installed successfully"
fi

# Initialize PostgreSQL if needed
if [ ! -d /data/postgres ]; then
    echo "Initializing PostgreSQL..."
    mkdir -p /data/postgres
    chown postgres:postgres /data/postgres
    su postgres -c "/usr/lib/postgresql/17/bin/initdb -D /data/postgres"

    # Configure PostgreSQL for password authentication
    echo "host all all 127.0.0.1/32 md5" >> /data/postgres/pg_hba.conf
    echo "host all all ::1/128 md5" >> /data/postgres/pg_hba.conf
    echo "local all all md5" >> /data/postgres/pg_hba.conf
    
    # Note: We don't start/stop postgres here because the supervisor process will start it
    # The treasury database and password will be set up when the postgres process starts
fi

# Wait for PostgreSQL to be ready (started by supervisor)
echo "Waiting for PostgreSQL to start..."
for i in {1..30}; do
    if su postgres -c "psql -c '\l'" 2>/dev/null; then
        echo "PostgreSQL is ready"
        break
    fi
    sleep 1
done

# Create treasury database and set password if needed
if ! su postgres -c "psql -lqt" 2>/dev/null | cut -d \| -f 1 | grep -qw treasury; then
    echo "Creating treasury database..."
    su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
    su postgres -c "createdb treasury"
fi

# Run sandbox initialization
exec /usr/local/bin/sandbox-init "$@"
