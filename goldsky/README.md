Quick documentation on how to initialize the sink Postgres database:

```sql
-- as a superuser (e.g. psql -U postgres)

-- 1. Owner user + database
CREATE USER goldsky WITH PASSWORD 'change-me';
GRANT goldsky TO CURRENT_USER;
CREATE DATABASE goldsky OWNER goldsky;

-- 2. Read-only user
CREATE USER goldsky_ro WITH PASSWORD 'change-me';
```

Then connect to the goldsky database (important — grants are per-database) and set up read-only access:

```sql
-- psql -U postgres -d goldsky

GRANT CONNECT ON DATABASE goldsky TO goldsky_ro;
GRANT USAGE ON SCHEMA public TO goldsky_ro;

-- read access to everything that already exists
GRANT SELECT ON ALL TABLES IN SCHEMA public TO goldsky_ro;

-- read access to tables created in the future by the owner
ALTER DEFAULT PRIVILEGES FOR ROLE goldsky IN SCHEMA public
  GRANT SELECT ON TABLES TO goldsky_ro;
```
