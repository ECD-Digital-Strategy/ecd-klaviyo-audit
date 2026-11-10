-- Audit 2026-11-10 (HIGH): anyone with the public app key could LIST the
-- audit-assets bucket, including the PDFs and images attached to the proposal,
-- document and web-audit assistants (proposal-agent/, document-agent/). The app
-- never lists or downloads through the API: every file is shown by its public
-- URL, which a public bucket serves without this policy, and every upload is
-- upsert:false (INSERT only). So listing is simply removed. Files stay reachable
-- only by their exact URL, which is only stored where staff can see it.
drop policy if exists "Public read audit assets bucket" on storage.objects;
