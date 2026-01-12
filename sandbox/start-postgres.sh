#!/bin/bash
# Wait for PostgreSQL data directory to be initialized by sandbox-init
echo "Waiting for PostgreSQL data directory..."
while [ ! -f /data/postgres/PG_VERSION ]; do
    sleep 1
done
echo "PostgreSQL data directory ready, starting server..."
exec /usr/lib/postgresql/16/bin/postgres -D /data/postgres -c listen_addresses='*'
