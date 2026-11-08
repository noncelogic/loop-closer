-- Runs once, on first boot of an empty data directory, against POSTGRES_DB.
-- pgvector backs Loop Closer's auxiliary (suggest-only) index, TECH-STACK §3.
CREATE EXTENSION IF NOT EXISTS vector;
