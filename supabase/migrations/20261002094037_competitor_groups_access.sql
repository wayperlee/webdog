-- Apply only after the competitor_group Drizzle DDL in the private business schema.
BEGIN;
ALTER TABLE sitemap_radar.competitor_group ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sitemap_radar.competitor_group FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON sitemap_radar.competitor_group TO sitemap_radar_app;
CREATE POLICY radar_server ON sitemap_radar.competitor_group FOR ALL TO sitemap_radar_app USING (true) WITH CHECK (true);
COMMIT;
