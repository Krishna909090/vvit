DO $$
DECLARE
    tbl RECORD;
BEGIN
    FOR tbl IN
        SELECT table_name
        FROM information_schema.columns
        WHERE column_name = 'updatedAt'
          AND table_schema = 'public'
    LOOP
        EXECUTE format('ALTER TABLE %I ALTER COLUMN "updatedAt" SET DEFAULT NOW()', tbl.table_name);
        RAISE NOTICE 'Added DEFAULT NOW() to table: %', tbl.table_name;
    END LOOP;
END $$;
