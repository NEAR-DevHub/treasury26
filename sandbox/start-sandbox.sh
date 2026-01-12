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
    curl -L "$SANDBOX_URL" | tar -xz -C /usr/local/bin
    chmod +x /usr/local/bin/near-sandbox
fi

# Initialize PostgreSQL if needed
if [ ! -d /data/postgres ]; then
    echo "Initializing PostgreSQL..."
    mkdir -p /data/postgres
    chown postgres:postgres /data/postgres
    su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /data/postgres"

    # Configure PostgreSQL for password authentication
    echo "host all all 127.0.0.1/32 md5" >> /data/postgres/pg_hba.conf
    echo "host all all ::1/128 md5" >> /data/postgres/pg_hba.conf

    # Create database and set password
    su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /data/postgres -l /var/log/postgres-init.log start"
    sleep 2
    su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\""
    su postgres -c "createdb treasury"
    su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /data/postgres stop"
fi

# Run sandbox initialization
exec /usr/local/bin/sandbox-init "$@"
