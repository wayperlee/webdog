-- Apply on the newly created Sitemap Radar project only.
-- Business-table migrations are applied by npm run db:migrate:scoped.
CREATE SCHEMA IF NOT EXISTS sitemap_radar;
REVOKE ALL ON SCHEMA sitemap_radar FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sitemap_radar
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sitemap_radar
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sitemap_radar
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
