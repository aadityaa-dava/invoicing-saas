#!/bin/sh
# Runs once, on first initialization of an empty Postgres data volume.
# Implements the two-role model from ADR-0003.
# app_owner has CREATEDB only because Prisma's migrate dev needs a shadow
# database locally. Production roles will not get it.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$APP_OWNER_PASSWORD" \
  -v user_pw="$APP_USER_PASSWORD" \
  -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_owner LOGIN CREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE app_user  LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'user_pw';

ALTER DATABASE :"dbname" OWNER TO app_owner;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO app_owner, app_user;

GRANT USAGE ON SCHEMA public TO app_user;

-- Tables and sequences that app_owner creates later are usable by app_user.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
SQL
