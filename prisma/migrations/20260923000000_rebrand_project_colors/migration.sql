-- rebrand_project_colors migration
--
-- Strategy: data-only rewrite of the Project.color slug. The rebrand retires
-- the decorative "cyan"/"pink" accents and the generic "primary"/"info"
-- slugs in favour of the emerald ramp plus a neutral, so PROJECT_COLORS in
-- lib/schemas/project.ts is now ["emerald", "forest", "mint", "slate",
-- "warning"]. Rows written before this migration still hold the old slugs;
-- every read path (the project card's COLOR_CLASSES lookup, the swatch
-- pickers) would fall through to its default and render an off-brand or
-- blank swatch, and any edit that re-parses the row through the zod enum
-- would fail validation. This maps each retired slug onto its replacement.
--
-- Mapping:
--   primary, cyan -> emerald   (both were "the accent"; emerald is the brand green)
--   pink          -> mint
--   info          -> slate
--   warning       -> unchanged (survives the rebrand as-is)
--
-- "color" is a plain TEXT column with a DEFAULT, not a Postgres enum, so
-- there is no type to migrate. The column DEFAULT did need changing: it was
-- 'primary', which is no longer a member of PROJECT_COLORS. In practice the
-- default is dead code (the zod ColorField is required and the server action
-- always supplies a colour), but leaving an invalid literal as the DEFAULT
-- is a trap for the next person who inserts a row by hand. Kept in step with
-- prisma/schema.prisma:538.
--
-- Idempotent and safe to re-run: each UPDATE is keyed on a retired slug and
-- writes a new slug that no WHERE clause here matches, so a second run
-- matches zero rows. Destructive only in the sense that the old slug is not
-- recoverable — it carries no meaning beyond the swatch, and the nightly
-- pg_dump has the prior state if anyone needs it.

UPDATE "Project" SET "color" = 'emerald' WHERE "color" IN ('primary', 'cyan');
UPDATE "Project" SET "color" = 'mint'    WHERE "color" = 'pink';
UPDATE "Project" SET "color" = 'slate'   WHERE "color" = 'info';
-- 'warning' survives unchanged

-- The DEFAULT still named a retired slug; bring it onto the new palette.
ALTER TABLE "Project" ALTER COLUMN "color" SET DEFAULT 'emerald';
