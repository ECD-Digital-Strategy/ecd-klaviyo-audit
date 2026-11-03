-- Speed (Emil, 2026-11-03: "the platform is kind of slow"). pg_net keeps the
-- responses of our scheduled HTTP calls in net._http_response and deletes old ones
-- constantly. The table is UNLOGGED and autovacuum had never touched it: 60 live
-- rows in 11 MB, the delete walked 8,000 dead index entries every time (270 ms,
-- 3.7 hours of database time since September). A VACUUM FULL took it to 0.01 ms;
-- this keeps it that way.
select cron.schedule(
  'vacuum-net-responses',
  '43 3 * * *',
  $cron$ vacuum (analyze) net._http_response; $cron$
);
